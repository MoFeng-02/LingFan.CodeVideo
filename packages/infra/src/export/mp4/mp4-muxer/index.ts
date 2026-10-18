/**
 * MP4 封装模块公共入口：封装器与帧/轨道类型。
 *
 * 对外只暴露「追加编码块 → 收尾出字节」这一条用法：块的顺序即容器里的顺序，
 * 时间戳单位是微秒（编码器输出的原生单位），尺寸单位是像素。
 * 盒布局、采样表等细节留在本目录内部，改动它们不影响使用者。
 */
export { Mp4Muxer } from "./muxer";
export type {
  AudioChunkSpec,
  AudioTrackSpec,
  VideoChunkSpec,
  VideoTrackSpec,
} from "./chunks";
