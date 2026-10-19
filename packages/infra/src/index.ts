/**
 * @lingfan-video/infra：契约的默认适配器集（端口与适配器成对）。
 * 只依赖 @lingfan-video/contracts（能力只依赖契约，不知道 core 存在）。
 *
 * 大致按端口分组：
 * - **导出**：三条产物形态不同的路径——`FrameSequenceExporter`（逐帧原始位图，
 *   无损可再加工）、`WebCodecsExporter`（浏览器硬编，产物是 mp4 文件）、
 *   以及给 mp4 封装用的 `Mp4Muxer` 与轨道/块类型；
 * - **预览**：`PacedPreviewExporter` 与 `CanvasBlitExporter`，都是按实时节奏
 *   放行的 `frames` 导出器，用来在页面里看推演结果，不做编码；
 * - **帧合成**：经 `./frames` 再导出（合成器接缝、合成宿主、层计划、载体工具）；
 * - **采集**：`MemoryFrameSink`，把帧留在内存里供断言/比对；
 * - **诊断**：指纹、逐帧差分、连续性报告与确定性比对；
 * - **音频**：离线混音、合成器、Web Audio 输出与变速/语音时间线工具。
 *
 * 这里是**默认实现**的集合，不是唯一实现：契约层定义的端口可以被任意实现替换，
 * 上层组合根决定用哪一个。子路径导出（如 `.../frames/adapters/*`）承载按需加载的
 * 可选后端，不经这里。
 */
export { FrameSequenceExporter } from "./export/frame-sequence-exporter";
export { WebCodecsExporter } from "./export/webcodecs";
export type { WebCodecsExporterOptions } from "./export/webcodecs";
export { Mp4Muxer } from "./export/mp4";
export type {
  AudioChunkSpec,
  AudioTrackSpec,
  VideoChunkSpec,
  VideoTrackSpec,
} from "./export/mp4";
export { MemoryFrameSink } from "./capture/memory-sink";
export { OfflineAudioMixer } from "./audio/offline-mixer";
export {
  DEFAULT_SYNTH_GAIN,
  renderSynth,
  seededRandom,
  synthAmpEnvelopePoints,
  synthEnvelopeAt,
  synthEnvelopePoints,
  synthSeed,
} from "./audio/synth";
export type { SynthPcm } from "./audio/synth";
export type {
  AudioDecoder,
  DecodedPcm,
  OfflineAudioMixerOptions,
} from "./audio/offline-mixer";
export { WebAudioOutput } from "./audio/web-audio-player";
export type { AudioBufferLoader } from "./audio/web-audio-player";
export { PacedPreviewExporter } from "./preview/paced-exporter";
export type { PacedPreviewOptions } from "./preview/paced-exporter";
export {
  FrameHasher,
  auditDeterminism,
  compareFrameHashes,
  compareFingerprints,
  continuityReport,
  frameDelta,
  frameFingerprint,
  sequenceFingerprint,
} from "./diagnostics";
export type {
  AuditOptions,
  ContinuityOptions,
  ContinuityReport,
  DeterminismReport,
  FrameDelta,
  FrameHash,
  FrameMismatch,
} from "./diagnostics";
export {
  isAudible,
  evaluateVoice,
  type GainPoint,
  type VoiceTimeline,
} from "./audio/voice-timeline";
export {
  rateSegments,
  resolveWarp,
  sourceMsAt,
  timelineMsAtSource,
} from "./audio/warp";
export type { ResolvedWarp, WarpRateSegment } from "./audio/warp";
export * from "./frames";
export { CanvasBlitExporter } from "./preview/canvas-blit-exporter";
