/** 声音求值模块的公共类型：运行期操作、速率分段、增益折点与可执行时间线。 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";

/** 速率分段：段内速率由 fromRate 线性变到 toRate（相等即常量段） */
export interface RatePiece {
  readonly fromMs: Ms;
  readonly toMs: Ms;
  readonly fromRate: number;
  readonly toRate: number;
  /** 段起点对应的源内毫秒 */
  readonly sourceFrom: Ms;
}

/** 增益折点（全局毫秒），段内线性——预览端直接当 AudioParam 自动化用 */
export interface GainPoint {
  readonly atMs: Ms;
  readonly gain: number;
}

/** 一个声音的可执行时间线（导出与预览共用） */
export interface VoiceTimeline {
  /** 全局起点（毫秒） */
  readonly startMs: Ms;
  /** 全局终点（毫秒；已按源播完/stop/until/总时间线尾决定） */
  readonly endMs: Ms;
  readonly loop: boolean;
  readonly pan: number;
  /** 全局毫秒 → 源内毫秒（已按 loop 回卷；越界裁到源内） */
  sourceMsAt(globalMs: Ms): Ms;
  /** 全局毫秒处的瞬时速率（音高倍率） */
  rateAt(globalMs: Ms): number;
  /** 全局毫秒处的线性增益（0..N，含淡入淡出、setGain、stop 淡出） */
  gainAt(globalMs: Ms): number;
  readonly gainPoints: readonly GainPoint[];
}

export type StopOp = Extract<AudioVoice["ops"][number], { kind: "stop" }>;
export type GainOp = Extract<AudioVoice["ops"][number], { kind: "gain" }>;
export type RateOp = Extract<AudioVoice["ops"][number], { kind: "rate" }>;
