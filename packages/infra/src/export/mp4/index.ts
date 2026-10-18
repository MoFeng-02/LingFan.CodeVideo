/**
 * mp4 封装模块公共入口：封装器、轨道声明、以及编码器需要的参数集工具。
 * 盒原语与 AAC/AVC 声明细节不外泄。
 *
 * 这一层只做容器，不碰像素也不碰时钟：调用方按到达顺序追加编码块
 * （`Mp4Muxer.addVideo` / `addAudio`），最后 `finalize` 一次拼出完整文件字节。
 * 时间戳以编码块自带的为准，因此容器与「按什么节奏推演」无关；
 * 使用它的导出器（WebCodecs 那条）负责保证帧与音频在 `finalize` 之前写完。
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
