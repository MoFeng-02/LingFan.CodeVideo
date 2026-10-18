/** 预览端 AudioParam 自动化：把求值结果（速率分段 / 增益折点）写成参数事件。 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";
import { rateSegments, resolveWarp } from "../warp";

/**
 * 变速自动化：warp 锚点斜率 / 恒速率 → playbackRate 分段（与导出端同一张表）。
 * playbackRate 重采样即磁带式变调，预览与离线混音的音高/时长一致。
 */
export function applyRate(
  ctx: AudioContext,
  ctxSecOf: (ms: Ms) => number,
  param: AudioParam,
  voice: AudioVoice,
  startMs: Ms,
  sourceDurationMs: Ms,
): void {
  const start = ctxSecOf(startMs);
  const rate = voice.rate;
  if (!rate) return;
  if (rate.kind === "rate") {
    param.setValueAtTime(rate.value, Math.max(start, ctx.currentTime));
    return;
  }
  const w = resolveWarp(rate.points, sourceDurationMs);
  const segs = rateSegments(w);
  for (const seg of segs) {
    const t = Math.max(start + seg.fromMs / 1000, ctx.currentTime);
    param.setValueAtTime(seg.rate, t);
  }
}

/** 增益折线自动化（求值点给出的折点 → AudioParam 线性段），终点归零 */
export function applyGain(
  ctxSecOf: (ms: Ms) => number,
  param: AudioParam,
  points: readonly { atMs: Ms; gain: number }[],
  endSec: number,
): void {
  const first = points[0];
  if (!first) return;
  param.setValueAtTime(first.gain, ctxSecOf(first.atMs));
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    param.linearRampToValueAtTime(p.gain, ctxSecOf(p.atMs));
  }
  param.setValueAtTime(0, endSec);
}
