/**
 * 帧间差异与动画连贯性：把「帧和帧之间有没有跳变」变成可断言的数字。
 * 供 AI 与测试调试动画：切镜、漏帧、抖动、状态没接上，都会体现为 delta 序列上的尖峰。
 */
import type { FrameBitmap } from "@lingfan-video/contracts";

export interface FrameDelta {
  /** 逐通道绝对差的均值（0..255；0 = 像素完全相同） */
  readonly meanAbsDiff: number;
  /** 单通道最大绝对差（0..255） */
  readonly maxAbsDiff: number;
  /** 有任一通道变化的像素占比（0..1） */
  readonly changedRatio: number;
}

export interface ContinuityReport {
  /** 参与统计的帧数 */
  readonly frames: number;
  /** 相邻帧 delta 序列（长度 = frames - 1） */
  readonly deltas: readonly number[];
  readonly meanDelta: number;
  readonly maxDelta: number;
  /** 最大 delta 出现在第几帧（相对前一帧） */
  readonly maxDeltaAt: number;
  /** 跳变帧下标（delta > meanDelta * spikeFactor 且 > 1） */
  readonly spikeIndices: readonly number[];
  /** delta 序列的二阶波动均值：越小说明运动越连续（切镜会明显抬高） */
  readonly smoothness: number;
}

export interface ContinuityOptions {
  /** 尖峰阈值倍数（缺省 3） */
  readonly spikeFactor?: number;
}

function assertSameShape(prev: FrameBitmap, next: FrameBitmap): void {
  if (prev.width !== next.width || prev.height !== next.height) {
    const err = new Error(
      `spec_violation: 帧尺寸不一致（${prev.width}x${prev.height} vs ${next.width}x${next.height}），无法比较`,
    );
    err.name = "SpecViolation";
    throw err;
  }
  if (prev.data.length !== next.data.length) {
    const err = new Error("spec_violation: 帧像素长度不一致，无法比较");
    err.name = "SpecViolation";
    throw err;
  }
}

/** 两帧之间的差异（逐像素、逐通道） */
export function frameDelta(prev: FrameBitmap, next: FrameBitmap): FrameDelta {
  assertSameShape(prev, next);
  const a = prev.data;
  const b = next.data;
  let sum = 0;
  let max = 0;
  let changed = 0;
  const pixels = a.length / 4;
  for (let p = 0; p < a.length; p += 4) {
    let pixelChanged = false;
    for (let c = 0; c < 4; c++) {
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
 */
export function continuityReport(
  frames: readonly FrameBitmap[],
  options: ContinuityOptions = {},
): ContinuityReport {
  const spikeFactor = options.spikeFactor ?? 3;
  if (spikeFactor <= 0) {
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
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    deltas.push(frameDelta(frames[i - 1]!, frames[i]!).meanAbsDiff);
  }
  let sum = 0;
  let max = -1;
  let maxIndex = 0;
  for (let i = 0; i < deltas.length; i++) {
    const value = deltas[i]!;
    sum += value;
    if (value > max) {
      max = value;
      maxIndex = i;
    }
  }
  const mean = sum / deltas.length;
  const threshold = Math.max(mean * spikeFactor, 1);
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
