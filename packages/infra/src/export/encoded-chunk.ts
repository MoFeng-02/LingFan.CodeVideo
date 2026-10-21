/**
 * 编码块的字节拷贝：`EncodedVideoChunk` / `EncodedAudioChunk` 的底层缓冲归编码器
 * 复用，容器要长期持有就必须自己留一份。
 *
 * 两条编码路径（mp4 与 WebM）都用它，所以放在导出层的公共位置而不是任何一个
 * 封装目录里。
 */

/**
 * 拷贝一个编码块的数据。
 *
 * @param chunk 编码器交出的块（视频或音频）
 * @returns 独立缓冲的字节（不与编码器共享内存）
 */
export function copyChunkBytes(
  chunk: EncodedVideoChunk | EncodedAudioChunk,
): Uint8Array {
  /** 拷贝目标：按块的字节长度新开缓冲 */
  const out = new Uint8Array(new ArrayBuffer(chunk.byteLength));
  chunk.copyTo(out.buffer);
  return out;
}
