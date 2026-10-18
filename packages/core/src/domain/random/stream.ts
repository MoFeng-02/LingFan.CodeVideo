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

  next(): number {
    return this.step() / UINT32;
  }

  float(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min)
      throw violation(
        `random.int(${min}, ${max}) 要求整数且 max > min（右端不含）`,
      );
    return min + Math.floor(this.next() * (max - min));
  }

  chance(probability: number): boolean {
    if (!(probability >= 0 && probability <= 1))
      throw violation(`random.chance(${probability}) 要求 0..1`);
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw violation("random.pick 需要非空数组");
    return items[Math.floor(this.next() * items.length)]!;
  }

  fork(label: string): RandomStream {
    return new XorShift32Stream(foldSeed(this.base, label));
  }
}

/** 建一条程序随机子流（种子须是 0..2^32-1 的整数；归一化在组合根完成） */
export function createRandomStream(seed: number): RandomStream {
  return new XorShift32Stream(seed);
}

/** 种子校验：返回人读的错误描述，合法返回 null（纯检查） */
export function seedError(seed: unknown): string | null {
  if (typeof seed !== "number" || !Number.isInteger(seed))
    return `RenderOptions.seed 必须是 0..${UINT32 - 1} 的整数`;
  if (seed < 0 || seed >= UINT32)
    return `RenderOptions.seed 必须是 0..${UINT32 - 1} 的整数（收到 ${seed}）`;
  return null;
}
