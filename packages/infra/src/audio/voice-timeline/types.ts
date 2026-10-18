/** 声音求值模块的公共类型：运行期操作、速率分段、增益折点与可执行时间线。 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";

/** 速率分段：段内速率由 fromRate 线性变到 toRate（相等即常量段） */
export interface RatePiece {
  /** 段起点的全局毫秒 */
  readonly fromMs: Ms;
  /** 段终点的全局毫秒（开区间；下一段从这里接上） */
  readonly toMs: Ms;
  /** 段起点的速率（1 = 原速；>1 加速升调，<1 减速降调） */
  readonly fromRate: number;
  /** 段终点的速率（与 fromRate 相等时表示常量段） */
  readonly toRate: number;
  /** 段起点对应的源内毫秒 */
  readonly sourceFrom: Ms;
}

/** 增益折点（全局毫秒），段内线性——预览端直接当 AudioParam 自动化用 */
export interface GainPoint {
  /** 折点的全局毫秒 */
  readonly atMs: Ms;
  /** 折点处的线性增益（0 = 静音，1 = 原始电平） */
  readonly gain: number;
}

/** 一个声音的可执行时间线（出片与预览共用） */
export interface VoiceTimeline {
  /** 全局起点（毫秒） */
  readonly startMs: Ms;
  /** 全局终点（毫秒；已按源播完/stop/until/总时间线尾决定） */
  readonly endMs: Ms;
  /** 是否循环：true 时源播到尾部回卷到起点继续 */
  readonly loop: boolean;
  /** 声像（-1 = 全左、0 = 居中、1 = 全右；线性摆位，仅立体声输出生效） */
  readonly pan: number;
  /** 全局毫秒 → 源内毫秒（已按 loop 回卷；越界裁到源内） */
  sourceMsAt(globalMs: Ms): Ms;
  /** 全局毫秒处的瞬时速率（音高倍率） */
  rateAt(globalMs: Ms): number;
  /** 全局毫秒处的线性增益（0..N，含淡入淡出、setGain、stop 淡出） */
  gainAt(globalMs: Ms): number;
  /** 增益折点（按 atMs 递增，含淡入、运行期调节与淡出折点） */
  readonly gainPoints: readonly GainPoint[];
}

/** 停止操作：在 atMs（全局毫秒）处停声，fadeMs 为收尾淡出长度（0 = 立即静音） */
export type StopOp = Extract<AudioVoice["ops"][number], { kind: "stop" }>;
/** 音量操作：在 atMs（全局毫秒）处把增益拉到 value，rampMs 为过渡长度（0 = 立即生效） */
export type GainOp = Extract<AudioVoice["ops"][number], { kind: "gain" }>;
/** 速率操作：在 atMs（全局毫秒）处把速率拉到 value，rampMs 为过渡长度（0 = 立即生效） */
export type RateOp = Extract<AudioVoice["ops"][number], { kind: "rate" }>;
