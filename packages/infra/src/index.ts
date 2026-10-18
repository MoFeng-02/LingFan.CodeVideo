/**
 * @lingfan-video/infra：契约的默认适配器集（端口与适配器成对）。
 * 只依赖 @lingfan-video/contracts（能力只依赖契约，不知道 core 存在）。
 */
export { FrameSequenceExporter } from "./export/frame-sequence-exporter";
export { WebCodecsExporter } from "./export/webcodecs-exporter";
export type { WebCodecsExporterOptions } from "./export/webcodecs-exporter";
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
