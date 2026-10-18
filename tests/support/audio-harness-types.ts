/**
 * 记录型 AudioContext 替身的节点形状：预览端真正建了哪些节点、连到哪儿、参数被写成
 * 什么自动化事件，全部落在这几张记录表里，供与导出端求值结果逐点比对。
 *
 * 只看被预览端真正调用到的字段；缺的能力宁可让断言失败，也不静默通过。
 */

import type { ParamEvent, ParamLike } from "./audio-params";

export type NodeKind =
  | "gain"
  | "source"
  | "oscillator"
  | "delay"
  | "convolver"
  | "biquad"
  | "compressor"
  | "panner";

/** 一条连线（`to === -1` 表示接到 AudioContext.destination） */
export interface Edge {
  readonly from: number;
  readonly to: number;
}

/** 预览端从 AudioContext 拿到的最小缓冲形态（含逐声道样本，供 IR/噪声比对） */
export interface FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface SourceRec {
  readonly id: number;
  readonly kind: "source";
  loop: boolean;
  startAt?: number;
  offset?: number;
  stopAt?: number;
  /** playbackRate 的自动化事件（与导出端速率表比对） */
  readonly rate: ParamEvent[];
  buffer: FakeAudioBuffer | null;
  playbackRate: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
  start(at: number, offset?: number): void;
  stop(at?: number): void;
}

export interface GainRec {
  readonly id: number;
  readonly kind: "gain";
  /** 写在增益上的自动化事件 */
  readonly events: ParamEvent[];
  gain: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface OscRec {
  readonly id: number;
  readonly kind: "oscillator";
  type: string;
  startAt?: number;
  stopAt?: number;
  frequency: ParamLike;
  detune: ParamLike;
  /** detune 的自动化事件（预览端把运行期变速写成音分） */
  readonly detuneEvents: ParamEvent[];
  connect(target: unknown): void;
  disconnect(): void;
  start(at: number): void;
  stop(at?: number): void;
}

export interface DelayRec {
  readonly id: number;
  readonly kind: "delay";
  readonly maxDelayTime: number;
  readonly delayTime: ParamLike;
  readonly delayEvents: ParamEvent[];
  connect(target: unknown): void;
  disconnect(): void;
}

export interface ConvolverRec {
  readonly id: number;
  readonly kind: "convolver";
  buffer: FakeAudioBuffer | null;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface BiquadRec {
  readonly id: number;
  readonly kind: "biquad";
  type: string;
  frequency: ParamLike;
  Q: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface CompressorRec {
  readonly id: number;
  readonly kind: "compressor";
  threshold: ParamLike;
  ratio: ParamLike;
  attack: ParamLike;
  release: ParamLike;
  knee: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface PannerRec {
  readonly id: number;
  readonly kind: "panner";
  pan: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface Harness {
  readonly ctx: AudioContext;
  readonly sources: SourceRec[];
  readonly gains: GainRec[];
  readonly oscs: OscRec[];
  readonly delays: DelayRec[];
  readonly convolvers: ConvolverRec[];
  readonly biquads: BiquadRec[];
  readonly compressors: CompressorRec[];
  readonly panners: PannerRec[];
  /** 每次 createBuffer 的 0 声道样本（噪声/IR 逐样本比对的入口） */
  readonly buffers: Float32Array[];
  /** 节点间连线（预览端拓扑） */
  readonly edges: readonly Edge[];
  /** 节点类型（按 id 查） */
  kindOf(id: number): NodeKind | undefined;
  /** 指向 `id` 的边的来源节点 id（即 `id` 的输入） */
  inputsOf(id: number): number[];
  /** 从 `id` 流出的边的目标节点 id */
  outputsOf(id: number): number[];
}
