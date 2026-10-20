/**
 * PNG / APNG 产物：透明帧的落盘通道。
 *
 * 与 mp4 那条路的分工是格式决定的，不是实现取舍：H.264 没有 alpha 通道，
 * 带透明的画面进编码器只剩一片黑底；APNG 是 PNG 的动画扩展，逐帧保留 RGBA
 * 的 alpha，能在浏览器、设计工具与剪辑软件里直接当素材。
 *
 * 只做 8 位 RGBA、不隔行、过滤固定 None 的最小集——引擎交出的
 * `FrameBitmap.data` 就是 RGBA 交错字节，这里不改写像素，只加封装。
 */
export { ApngExporter } from "./apng-exporter";
export {
  PNG_SIGNATURE,
  deflateZlib,
  pngChunk,
  pngIhdr,
  pngScanlines,
} from "./png";
export { crc32 } from "./crc32";
