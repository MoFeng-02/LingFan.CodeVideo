/**
 * 单声音铺轨：时间线求值（唯一求值点）→ 源内位置线性插值重采样 → 包络 → pan。
 * 块处理只写块内交集，跨块状态都在时间线闭包里，因此整段与分块结果一致。
 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";
import { evaluateVoice, type VoiceTimeline } from "../voice-timeline";
import { panGain, posMod } from "./math";
import type { VoicePcm } from "./types";

interface VoicePlan {
  readonly voice: AudioVoice;
  readonly pcm: VoicePcm;
  readonly timeline: VoiceTimeline;
  /** 输出采样网格上的起止帧（左闭右开） */
  readonly startFrame: number;
  readonly endFrame: number;
  readonly srcRate: number;
  readonly srcCh: number;
  readonly srcFrames: number;
}

/** 时间线求值一次，得到输出帧区间与源取样参数 */
function planVoice(
  voice: AudioVoice,
  pcm: VoicePcm,
  durationMs: Ms,
  sr: number,
): VoicePlan {
  const timeline = evaluateVoice(voice, pcm.durationMs, durationMs);
  const srcCh = pcm.channels;
  return {
    voice,
    pcm,
    timeline,
    startFrame: Math.round((timeline.startMs / 1000) * sr),
    endFrame: Math.round((timeline.endMs / 1000) * sr),
    srcRate: pcm.sampleRate,
    srcCh,
    srcFrames: pcm.data.length / srcCh,
  };
}

/** 交错 PCM 线性插值取样（声道越界回卷；单声道源映射到多声道时复制） */
function sampleAt(
  plan: VoicePlan,
  frame: number,
  frac: number,
  ch: number,
): number {
  const { pcm, srcCh, srcFrames } = plan;
  const srcChIdx = srcCh === 1 ? 0 : Math.min(ch, srcCh - 1);
  const i0 = frame * srcCh + srcChIdx;
  const v0 = pcm.data[i0] ?? 0;
  if (frac === 0) return v0;
  const i1 = i0 + srcCh;
  const v1 = frame + 1 < srcFrames ? (pcm.data[i1] ?? 0) : v0;
  return v0 + (v1 - v0) * frac;
}

/** 把一个声音在 [blockStart, blockStart+frames) 内的样本叠入目标交错块 */
function layVoice(
  plan: VoicePlan,
  target: Float32Array,
  blockStart: number,
  frames: number,
  sr: number,
  channels: number,
): void {
  const from = Math.max(plan.startFrame, blockStart);
  const to = Math.min(plan.endFrame, blockStart + frames);
  for (let fr = from; fr < to; fr++) {
    const globalMs = (fr * 1000) / sr;
    // 时间线毫秒 → 源内帧位置；loop 在源空间回卷，越界（非 loop）静音收尾
    const srcIdxF = (plan.timeline.sourceMsAt(globalMs) / 1000) * plan.srcRate;
    const wrapped = plan.timeline.loop
      ? posMod(srcIdxF, plan.srcFrames)
      : srcIdxF;
    if (!plan.timeline.loop && wrapped >= plan.srcFrames) break;
    const gain = plan.timeline.gainAt(globalMs);
    if (gain <= 0) continue;
    const s0 = Math.floor(wrapped);
    const frac = wrapped - s0;
    const base = (fr - blockStart) * channels;
    for (let ch = 0; ch < channels; ch++) {
      const s = sampleAt(plan, s0, frac, ch);
      target[base + ch]! += s * gain * panGain(plan.timeline.pan, ch, channels);
    }
  }
}

export { layVoice, planVoice };
export type { VoicePlan };
