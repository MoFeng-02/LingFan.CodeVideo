/**
 * 帧间差异与动画连贯性：把「帧和帧之间有没有跳变」变成可断言的数字。
 * 供 AI 与测试调试动画：切镜、漏帧、抖动、状态没接上，都会体现为 delta 序列上的尖峰。
 *
 * 测量口径：所有差异都基于 RGBA 字节直接比较（含 alpha 通道），
 * 不经过任何色彩空间转换或编码，因此同一组输入在任何机器上得到同样的数字。
 * 自身开销：`frameDelta` 是 O(像素数) 的一次遍历，只读不写、不分配大缓冲；
 * `continuityReport` 会对相邻帧各算一次，整体约 O(帧数 × 像素数)。
 */
import type { FrameBitmap } from "@lingfan-video/contracts";

/** 两帧之间的差异度量（归一化到通道/像素之比，与分辨率无关） */
export interface FrameDelta {
  /** 逐通道绝对差的均值（0..255；0 = 像素完全相同） */
  readonly meanAbsDiff: number;
  /** 单通道最大绝对差（0..255） */
  readonly maxAbsDiff: number;
  /** 有任一通道变化的像素占比（0..1） */
  readonly changedRatio: number;
}

/** 一段帧序列的连贯性报告：delta 序列 + 汇总量 + 跳变点 */
export interface ContinuityReport {
  /** 参与统计的帧数 */
  readonly frames: number;
  /** 相邻帧 delta 序列（长度 = frames - 1；元素为 `meanAbsDiff`，0..255） */
  readonly deltas: readonly number[];
  /** delta 序列的算术均值（0..255；帧数 < 2 时为 0） */
  readonly meanDelta: number;
  /** delta 序列的最大值（0..255；帧数 < 2 时为 0） */
  readonly maxDelta: number;
  /** 最大 delta 出现在第几帧（相对前一帧） */
  readonly maxDeltaAt: number;
  /** 跳变帧下标（delta > meanDelta * spikeFactor 且 > 1） */
  readonly spikeIndices: readonly number[];
  /** delta 序列的二阶波动均值：越小说明运动越连续（切镜会明显抬高） */
  readonly smoothness: number;
}

/** 连贯性统计参数 */
export interface ContinuityOptions {
  /** 尖峰阈值倍数（缺省 3）；实际阈值取 `max(meanDelta * spikeFactor, 1)`，
   * 必须是正数，否则抛 spec_violation */
  readonly spikeFactor?: number;
}

/**
 * 断言两帧可比较：尺寸与像素缓冲长度都必须一致，否则抛 spec_violation。
 *
 * @param prev 前一帧
 * @param next 后一帧
 */
function assertSameShape(prev: FrameBitmap, next: FrameBitmap): void {
  if (prev.width !== next.width || prev.height !== next.height) {
    /** 尺寸不符的错误：标成 `SpecViolation` 再抛，调用方按名字区分用法错误 */
    const err = new Error(
      `spec_violation: 帧尺寸不一致（${prev.width}x${prev.height} vs ${next.width}x${next.height}），无法比较`,
    );
    err.name = "SpecViolation";
    throw err;
  }
  if (prev.data.length !== next.data.length) {
    /** 像素长度不符的错误（宽高相同但缓冲不一致），同样标成 `SpecViolation` */
    const err = new Error("spec_violation: 帧像素长度不一致，无法比较");
    err.name = "SpecViolation";
    throw err;
  }
}

/**
 * 两帧之间的差异（逐像素、逐通道）。
 *
 * 尺寸必须一致（否则抛 spec_violation）；alpha 通道同样计入，
 * 所以「画面一样但透明度渐变」也会被算作有差异。
 *
 * @param prev 前一帧（RGBA 位图）
 * @param next 后一帧，尺寸必须与 `prev` 相同
 * @returns 三个归一化度量：均值、最大值、变化像素占比
 */
export function frameDelta(prev: FrameBitmap, next: FrameBitmap): FrameDelta {
  assertSameShape(prev, next);
  /** 前一帧的 RGBA 像素缓冲（尺寸已校验一致） */
  const a = prev.data;
  /** 后一帧的 RGBA 像素缓冲，与 `a` 等长、逐字节对齐 */
  const b = next.data;
  /** 全部通道绝对差之和（最后除以像素数 × 4 得均值） */
  let sum = 0;
  /** 单通道最大绝对差（0..255） */
  let max = 0;
  /** 有任一通道变化的像素数（最后除以像素数得占比） */
  let changed = 0;
  /** 像素数 = 通道字节数 / 4 */
  const pixels = a.length / 4;
  for (let p = 0; p < a.length; p += 4) {
    /** 本像素是否有任一通道变化（一个像素只计一次） */
    let pixelChanged = false;
    for (let c = 0; c < 4; c++) {
      /** 当前通道的绝对差（0..255） */
      const diff = Math.abs(a[p + c]! - b[p + c]!);
      sum += diff;
      if (diff > max) max = diff;
      if (diff !== 0) pixelChanged = true;
    }
    if (pixelChanged) changed++;
  }
  return {
    meanAbsDiff: pixels === 0 ? 0 : sum / (pixels * 4),
    maxAbsDiff: max,
    changedRatio: pixels === 0 ? 0 : changed / pixels,
  };
}

/**
 * 连贯性报告：对一段帧序列给出 delta 序列、均值/最大值与跳变点。
 * 帧数 < 2 时返回空序列（不报错：单帧推演也是合法推演）。
 *
 * 所有相邻帧都会先校验尺寸一致；帧序列按时间顺序传入，
 * 间隔是否均匀由调用方保证——本函数不看时间戳，只按相邻关系计算。
 *
 * @param frames 按时间顺序排列的帧序列（可为空或单帧）
 * @param options 统计参数，缺省 `{}`（尖峰倍数 3）
 * @returns 连贯性报告；`deltas.length = max(0, frames.length - 1)`
 */
export function continuityReport(
  frames: readonly FrameBitmap[],
  options: ContinuityOptions = {},
): ContinuityReport {
  /** 尖峰判定倍数（缺省 3，必须为正） */
  const spikeFactor = options.spikeFactor ?? 3;
  if (spikeFactor <= 0) {
    /** 参数越界的错误：`spikeFactor` 必须为正，否则尖峰判定无意义 */
    const err = new Error(
      `spec_violation: spikeFactor 必须是正数（收到 ${spikeFactor}）`,
    );
    err.name = "SpecViolation";
    throw err;
  }
  if (frames.length < 2) {
    return {
      frames: frames.length,
      deltas: [],
      meanDelta: 0,
      maxDelta: 0,
      maxDeltaAt: 0,
      spikeIndices: [],
      smoothness: 0,
    };
  }
  /** 相邻帧 delta 序列（0..255，长度 = 帧数 - 1） */
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    deltas.push(frameDelta(frames[i - 1]!, frames[i]!).meanAbsDiff);
  }
  /** 最大值累加器（初值 -1，保证任何非负 delta 都能覆盖） */
  let sum = 0;
  /** 当前最大值（初值 -1 表示尚未取到） */
  let max = -1;
  /** 最大值所在下标，供 `maxDeltaAt` 使用 */
  let maxIndex = 0;
  for (let i = 0; i < deltas.length; i++) {
    /** 当前 delta（0..255） */
    const value = deltas[i]!;
    sum += value;
    if (value > max) {
      max = value;
      maxIndex = i;
    }
  }
  /** delta 序列均值：作为尖峰判定的基准 */
  const mean = sum / deltas.length;
  /** 尖峰阈值：至少 1，避免均值接近 0 时把微小变化全判成尖峰 */
  const threshold = Math.max(mean * spikeFactor, 1);
  /** 二阶差绝对值之和（相邻 delta 的波动，最后取均值） */
  let secondDiff = 0;
  for (let i = 1; i < deltas.length; i++) {
    secondDiff += Math.abs(deltas[i]! - deltas[i - 1]!);
  }
  return {
    frames: frames.length,
    deltas,
    meanDelta: mean,
    maxDelta: max < 0 ? 0 : max,
    maxDeltaAt: maxIndex,
    spikeIndices: deltas
      .map((value, index) => (value > threshold ? index : -1))
      .filter((index) => index >= 0),
    smoothness: deltas.length < 2 ? 0 : secondDiff / (deltas.length - 1),
  };
}
