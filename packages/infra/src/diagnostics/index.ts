/**
 * 诊断包出口：确定性校验（帧指纹、比对报告）与帧间连贯性度量。
 *
 * 这里都是旁路能力：不参与推演与出片，只把过程产物变成可比对的数字，
 * 供测试、AI 调试与「引擎改了画面有没有变」的回归判断使用。
 */
export {
  FrameHasher,
  auditDeterminism,
  compareFrameHashes,
  compareFingerprints,
} from "./audit";
export type {
  AuditOptions,
  DeterminismReport,
  FrameHash,
  FrameMismatch,
} from "./audit";
export { frameFingerprint, sequenceFingerprint } from "./hash";
export { continuityReport, frameDelta } from "./metrics";
export type {
  ContinuityOptions,
  ContinuityReport,
  FrameDelta,
} from "./metrics";
