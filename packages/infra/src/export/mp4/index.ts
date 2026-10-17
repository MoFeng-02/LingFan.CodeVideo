/**
 * mp4 封装模块公共入口：封装器、轨道声明、以及编码器需要的参数集工具。
 * 盒原语与 AAC/AVC 声明细节不外泄。
 */
export { Mp4Muxer } from "./mp4-muxer";
export type {
  AudioChunkSpec,
  AudioTrackSpec,
  VideoChunkSpec,
  VideoTrackSpec,
} from "./mp4-muxer";
export { extractParameterSets, makeAvcC } from "./avc";
export type { AvcParameterSets } from "./avc";
export { makeAacConfig } from "./aac";
