/** 预览端排程模块共用的类型：加载器、总线节点组与播放器上下文。 */
import type { BusId, BusSpec, BusUpdate, Ms } from "@lingfan-video/contracts";

/** 资源加载：把 clip url 变成 AudioBuffer（宿主注入，通常 fetch + decodeAudioData） */
export type AudioBufferLoader = (url: string) => Promise<AudioBuffer>;

/** 一条总线的节点链：input 为汇入点，tail 为对外出口（效果与摆位之后） */
export interface BusNode {
  spec: BusSpec;
  input: GainNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
  tail: AudioNode;
}

/** 播放器向排程/参数模块暴露的上下文：时间换算、节点表与缓冲缓存 */
export interface PlayerEnv {
  readonly ctx: AudioContext;
  readonly buses: Map<BusId, BusNode>;
  readonly busParams: Map<BusId, BusUpdate>;
  readonly sources: AudioScheduledSourceNode[];
  readonly programDurationMs: number;
  /** 全局时间线毫秒 → 上下文秒（已过起点时为负） */
  ctxSecOf(globalMs: Ms): number;
  /** 当前时间线位置（毫秒） */
  nowMs(): Ms;
  /** 带缓存的缓冲加载 */
  bufferOf(url: string): Promise<AudioBuffer>;
}
