/**
 * WebM 导出适配器的唯一出口。
 *
 * 分三层，各自可单独使用：
 * - `ebml` / `ids`：EBML 原语与元素 ID，只做封装方向的构造；
 * - `blocks` / `webm-muxer`：簇与块的拼装、段与轨道表、索引表——只认已编码块；
 * - `video-track` / `audio-track` / `exporter`：编码器生命周期与 `Exporter` 实现。
 *
 * 外部的常规用法只有 `WebmExporter`；容器与编码轨单独导出，是给需要自己控制
 * 编码时机（例如分段出片后再拼装）的调用方留的入口。
 */
export { WebmExporter } from "./exporter";
export { WebmMuxer } from "./webm-muxer";
export { WebmVideoTrack, toVideoFrame, assertBitmapSize } from "./video-track";
export { WebmAudioTrack, opusHead } from "./audio-track";
export {
  ALPHA_BLOCK_ADD_ID,
  blockGroup,
  blockHeader,
  cluster,
  simpleBlock,
} from "./blocks";
export type { ClusterBlock } from "./blocks";
export type {
  WebmAudioChunk,
  WebmAudioSpec,
  WebmExporterOptions,
  WebmVideoChunk,
  WebmVideoCodec,
  WebmVideoSpec,
} from "./types";
export { WEBM_TIMECODE_SCALE_NS } from "./types";
