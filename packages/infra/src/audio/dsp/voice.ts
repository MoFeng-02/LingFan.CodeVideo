/**
 * 单声音铺轨：时间线求值（唯一求值点）→ 源内位置线性插值重采样 → 包络 → pan。
 *
 * 块处理只写块内交集，跨块状态都在时间线闭包里，因此整段渲染与分块渲染结果一致；
 * 时间单位在这里统一为毫秒，只有取样时才换算成帧。
 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";
import { evaluateVoice, type VoiceTimeline } from "../voice-timeline";
import { panGain, posMod } from "./math";
import type { VoicePcm } from "./types";

/** 一条声音的铺轨计划：求值一次，逐块复用 */
interface VoicePlan {
  /** 声音声明（毫秒） */
  readonly voice: AudioVoice;
  /** 源样本 */
  readonly pcm: VoicePcm;
  /** 求值后的时间线：源内位置、增益与摆位都从它取 */
  readonly timeline: VoiceTimeline;
  /** 输出采样网格上的起止帧（左闭右开） */
  readonly startFrame: number;
  readonly endFrame: number;
  /** 源采样率（Hz），用于把时间线毫秒换算成源内帧 */
  readonly srcRate: number;
  /** 源声道数 */
  readonly srcCh: number;
  /** 源总帧数（data.length / srcCh），非循环声音越界判据 */
  readonly srcFrames: number;
}

/**
 * 时间线求值一次，得到输出帧区间与源取样参数。
 *
 * 一个声音只在加入混音器时求值一次（见 `StreamingMixer.addVoice`），之后逐块铺轨只读
 * 这份计划；起止帧按输出采样网格四舍五入。
 *
 * @param voice 声音声明（时间单位毫秒，`startMs` 是总时间线绝对起点）
 * @param pcm 已解码样本，提供源采样率、声道数与源帧数
 * @param durationMs 总时间线时长（毫秒），作为声音的硬终界
 * @param sr 输出采样率（Hz）
 * @returns 铺轨计划
 */
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

/**
 * 交错 PCM 线性插值取样：整数帧 + 帧内小数部分。
 *
 * 单声道源映射到多声道输出时复制同一路；多声道源按输出声道序号取，源声道不足时取最后一路；
 * 末帧没有下一帧时直接用当前帧（不外插）。
 *
 * @param plan 铺轨计划
 * @param frame 源内整数帧位置
 * @param frac 帧内小数部分（0..1）；0 表示不插值
 * @param ch 输出声道序号
 * @returns 插值后的样本值（原值域，混音器不再钳制）
 */
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

/**
 * 把一个声音在 [blockStart, blockStart+frames) 内的样本叠入目标交错块。
 *
 * 只写块内交集，所以分块渲染与整段渲染结果一致；循环声音在源空间回卷，
 * 非循环声音越过源末尾即停止（后续帧不再写，静音收尾）。增益 ≤ 0 的帧直接跳过。
 *
 * @param plan 铺轨计划
 * @param target 交错输出块（就地累加，长度 ≥ frames × channels）
 * @param blockStart 本块第一帧在输出采样网格上的序号（帧）
 * @param frames 本块帧数
 * @param sr 输出采样率（Hz），帧 → 毫秒的唯一换算依据
 * @param channels 输出声道数
 */
function layVoice(
  plan: VoicePlan,
  target: Float32Array,
  blockStart: number,
  frames: number,
  sr: number,
  channels: number,
): void {
  /** 本块与声音区间的交集（左闭右开，帧） */
  const from = Math.max(plan.startFrame, blockStart);
  const to = Math.min(plan.endFrame, blockStart + frames);
  for (let fr = from; fr < to; fr++) {
    const globalMs = (fr * 1000) / sr;
    // 时间线毫秒 → 源内帧位置；loop 在源空间回卷，越界（非 loop）静音收尾
    const srcIdxF = (plan.timeline.sourceMsAt(globalMs) / 1000) * plan.srcRate;
    /** 回卷后的源内位置（帧，可为小数）；非循环时即原位置 */
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
