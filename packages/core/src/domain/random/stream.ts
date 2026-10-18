/**
 * 程序随机源：事件流式的可复现随机（同种子同步数必同序列）。
 *
 * 种子决定序列，标签派生子流：`fork(label)` 用「种子 + 标签」折叠出独立子流，
 * 因此给不同单元/单元内不同用途开子流时，互不扰动。随机只在逐帧求值里消费，
 * 求值顺序确定 → 序列确定，这是「同输入同输出」能成立的前提。
 *
 * 归一化（把种子收到 32 位无符号整数）在组合根完成，本文件只接受已归一的种子；
 * 全仓只有这一处随机实现，编辑器与出片端共用。
 */
import type { RandomStream } from "@lingfan-video/contracts";
import { violation } from "../spec-violation";

const UINT32 = 0x1_0000_0000;

/**
 * 程序随机源的折叠函数：把「程序种子 + 标签」折成一条子流的种子。
 * 逐字节无关的标签要给不同子流，故用 FNV-1a 32（对字节敏感）再雪崩一次。
 */
function foldSeed(seed: number, label: string): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** 零状态在 xorshift 里是死点，初始化先打散（splitmix 式混合） */
function mix32(v: number): number {
  let x = (v + 0x9e3779b9) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97) >>> 0;
  x ^= x >>> 15;
  return x >>> 0;
}

/**
 * xorshift32 流：一步一个样本，同种子同步数必同序列。
 * 编辑器/导出端都在 core 里求值，故这一处声明即全仓唯一定义。
 */
class XorShift32Stream implements RandomStream {
  private state: number;
  private readonly base: number;

  constructor(base: number) {
    this.base = base >>> 0;
    this.state = mix32(this.base);
  }

  private step(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  /** 下一个 [0, 1) 均匀分布样本 */
  next(): number {
    return this.step() / UINT32;
  }

  /**
   * 区间浮点样本：`[min, max)`（不校验顺序，调用方保证 `min < max`）。
   *
   * @param min 区间下界（含）
   * @param max 区间上界（不含）
   * @returns 区间内的均匀样本
   */
  float(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /**
   * 区间整数样本：`[min, max)`（右端不含）。
   *
   * @param min 下界（含，须为整数）
   * @param max 上界（不含，须为整数且大于 min）
   * @returns 区间内的整数样本
   * @throws spec_violation 两端不是整数或 max <= min 时
   */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min)
      throw violation(
        `random.int(${min}, ${max}) 要求整数且 max > min（右端不含）`,
      );
    return min + Math.floor(this.next() * (max - min));
  }

  /**
   * 按概率取真：样本 < 概率时为 true。
   *
   * @param probability 概率（0..1；0 恒假、1 恒真）
   * @returns 伯努利试验结果
   * @throws spec_violation 概率越界时
   */
  chance(probability: number): boolean {
    if (!(probability >= 0 && probability <= 1))
      throw violation(`random.chance(${probability}) 要求 0..1`);
    return this.next() < probability;
  }

  /**
   * 等概率抽取一个元素。
   *
   * @param items 候选数组（须非空）
   * @returns 被抽中的元素（原引用）
   * @throws spec_violation 数组为空时
   */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw violation("random.pick 需要非空数组");
    return items[Math.floor(this.next() * items.length)]!;
  }

  /**
   * 派生一条独立子流：同标签同子流，不同标签互不扰动。
   *
   * @param label 子流标签（同一父流下用于区分子流）
   * @returns 以「父种子 + 标签」折叠出的新流
   */
  fork(label: string): RandomStream {
    return new XorShift32Stream(foldSeed(this.base, label));
  }
}

/**
 * 建一条程序随机子流。
 *
 * @param seed 种子（0..2^32-1 的整数；归一化由调用方在组合根完成）
 * @returns 可复现的随机流
 */
export function createRandomStream(seed: number): RandomStream {
  return new XorShift32Stream(seed);
}

/**
 * 种子校验：返回人读的错误描述，合法返回 null（纯检查、不抛错）。
 *
 * @param seed 待校验的种子（任意类型）
 * @returns 问题描述；合法时为 null
 */
export function seedError(seed: unknown): string | null {
  if (typeof seed !== "number" || !Number.isInteger(seed))
    return `RenderOptions.seed 必须是 0..${UINT32 - 1} 的整数`;
  if (seed < 0 || seed >= UINT32)
    return `RenderOptions.seed 必须是 0..${UINT32 - 1} 的整数（收到 ${seed}）`;
  return null;
}
