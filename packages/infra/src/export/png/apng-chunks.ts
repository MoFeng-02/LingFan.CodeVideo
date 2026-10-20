/**
 * APNG 分块工具：动画控制、帧控制与帧数据的封装置。
 *
 * APNG 的帧序列由「fcTL + 数据块」交替构成：第一帧的数据块沿用 `IDAT`
 * （这样不认动画的解码器仍能拿到一张静态首帧），后续帧的数据块是 `fdAT`。
 * 每个 fcTL/fdAT 都带一个自增序号，序号从 0 起严格连续。
 */

import { pngChunk } from "./png";

/** 处置方式：不处置（下一帧直接叠加在前一帧上） */
const DISPOSE_NONE = 0;

/** 混合方式：以本帧 alpha 叠加到画布 */
const BLEND_OVER = 1;

/**
 * 构造 acTL（动画控制）分块：声明总帧数与循环次数。
 *
 * acTL 必须出现在第一个 `IDAT` 之前；总帧数在写文件时就是已知的
 * （推演的采样网格在出片前已编译出来），所以不需要占位回填。
 *
 * @param frameCount 总帧数
 * @param playCount 循环次数；0 = 无限循环
 * @returns acTL 分块字节
 */
export function apngActl(frameCount: number, playCount = 0): Uint8Array {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setUint32(0, frameCount);
  view.setUint32(4, playCount);
  return pngChunk("acTL", data);
}

/**
 * 构造 fcTL（帧控制）分块：序号、帧矩形、延时与处置/混合方式。
 *
 * 延时写成「分子 / 分母」的分数（秒）：分母给 1000 时分子即毫秒，
 * 这样引擎的毫秒时间戳能无损落进 APNG，不用先折成百分之一秒。
 *
 * @param sequenceNumber 该分块的序号（从 0 起连续）
 * @param width 帧宽（像素）
 * @param height 帧高（像素）
 * @param delayMs 本帧停留时长（毫秒）
 * @returns fcTL 分块字节
 */
export function apngFctl(
  sequenceNumber: number,
  width: number,
  height: number,
  delayMs: number,
): Uint8Array {
  const data = new Uint8Array(26);
  const view = new DataView(data.buffer);
  view.setUint32(0, sequenceNumber);
  view.setUint32(4, width);
  view.setUint32(8, height);
  view.setUint32(12, 0); // x_offset
  view.setUint32(16, 0); // y_offset
  view.setUint16(20, delayMs, true); // delay_num（小端）
  view.setUint16(22, 1000, true); // delay_den = 1000 → 分子单位是毫秒
  data[24] = DISPOSE_NONE;
  data[25] = BLEND_OVER;
  return pngChunk("fcTL", data);
}

/**
 * 构造 fdAT（帧数据）分块：序号 + 已压缩扫描线。
 *
 * @param sequenceNumber 该分块的序号（接在对应 fcTL 之后）
 * @param compressed 已 zlib 压缩的扫描线字节
 * @returns fdAT 分块字节
 */
export function apngFdat(
  sequenceNumber: number,
  compressed: Uint8Array,
): Uint8Array {
  const data = new Uint8Array(4 + compressed.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, sequenceNumber);
  data.set(compressed, 4);
  return pngChunk("fdAT", data);
}

/**
 * 把若干字节块首尾拼接成一整块。
 *
 * @param parts 待拼接的字节块
 * @returns 拼接结果
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
