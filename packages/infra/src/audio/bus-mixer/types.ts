/** 总线图混音模块的公共类型：混音输入与逐声音铺轨回调。 */
import type { AudioGraph, AudioVoice, Ms } from "@lingfan-video/contracts";

export interface BusMixInput {
  sampleRate: number;
  channels: number;
  frames: number;
  durationMs: Ms;
  voices: readonly AudioVoice[];
  graph: AudioGraph;
  /** 单声音铺轨（由混音器提供：时间映射/包络/pan 已实现，写入目标交错缓冲） */
  layoutVoice: (
    voice: AudioVoice,
    target: Float32Array,
    outFrames: number,
    durationMs: Ms,
  ) => void;
}
