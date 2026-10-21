/**
 * 音频样本的布局转换：`AudioData` 只收平面（f32-planar）布局，而 `writeAudio`
 * 的输入是交错样本。转换是两条编码路径（mp4 的 AAC 与 WebM 的 Opus）共用的
 * 一步，所以放在导出层的公共位置而不是任何一个编码目录里。
 */

/**
 * 把一段交错 Float32 样本转成平面布局。
 *
 * @param interleaved 交错样本（`[L0,R0,L1,R1,…]`），长度须覆盖到 `offsetFrames + frames`
 * @param channels 声道数
 * @param offsetFrames 从第几帧开始取（按帧计，不是按样本计）
 * @param frames 要取多少帧
 * @returns 平面样本（各声道依次放满 `frames` 个样本）；越界处补 0
 */
export function toPlanarFloat32(
  interleaved: Float32Array,
  channels: number,
  offsetFrames: number,
  frames: number,
): Float32Array {
  /** 平面布局结果：各声道依次放满 `frames` 个样本 */
  const out = new Float32Array(frames * channels);
  for (let ch = 0; ch < channels; ch++) {
    /** 本声道在输出里的起始下标 */
    const base = ch * frames;
    for (let f = 0; f < frames; f++) {
      out[base + f] = interleaved[(offsetFrames + f) * channels + ch] ?? 0;
    }
  }
  return out;
}
