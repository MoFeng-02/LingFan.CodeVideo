/**
 * PNG 分块工具：签名、分块封装、扫描线过滤与 zlib 压缩。
 *
 * 这里只做 PNG 规范要求的最小集（8 位 RGBA、无隔行、过滤器固定为 0），
 * 目的是把引擎交出的 `FrameBitmap` 原样落成带 alpha 的静态图——
 * 像素从 `FrameBitmap.data` 来，不重新解释颜色空间。
 */

import { crc32 } from "./crc32";

/** PNG 文件签名（8 字节固定魔数） */
export const PNG_SIGNATURE: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** 位深：每通道 8 位 */
const BIT_DEPTH = 8;

/** 颜色类型 6 = 真彩 + alpha（RGBA），正好对上 FrameBitmap 的布局 */
const COLOR_TYPE_RGBA = 6;

/**
 * 封装一个 PNG 分块（长度 + 类型 + 负载 + CRC）。
 *
 * @param type 四字符分块类型（如 `"IHDR"`）
 * @param data 分块负载
 * @returns 完整分块字节
 */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 构造 IHDR 分块负载：宽高、位深、颜色类型与隔行方式。
 *
 * @param width 画布宽（像素）
 * @param height 画布高（像素）
 * @returns IHDR 分块字节
 */
export function pngIhdr(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = BIT_DEPTH;
  data[9] = COLOR_TYPE_RGBA;
  data[10] = 0; // 压缩方法：唯一合法值
  data[11] = 0; // 过滤方法：唯一合法值
  data[12] = 0; // 隔行：不隔行
  return pngChunk("IHDR", data);
}

/**
 * 把一帧 RGBA 位图折成 PNG 扫描线（每行前缀过滤字节 0）。
 *
 * 过滤器固定 0（None）是有意选择：引擎交出的像素不保证有空间相关性
 * （合成结果是逐层叠加出来的），自适应过滤的收益不稳定，
 * 而「不额外改写像素」本身就是确定性更容易验证的那一侧。
 *
 * @param rgba RGBA 交错像素，长度 = width × height × 4
 * @param width 画布宽（像素）
 * @param height 画布高（像素）
 * @returns 待压缩的扫描线字节
 */
export function pngScanlines(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    out[rowStart] = 0; // 过滤类型：None
    for (let x = 0; x < stride; x++) {
      out[rowStart + 1 + x] = rgba[y * stride + x] as number;
    }
  }
  return out;
}

/**
 * 用 zlib 容器压缩一段字节（PNG 的 IDAT 负载要求 zlib 头 + 校验）。
 *
 * 走平台自带的 `CompressionStream`：不引入依赖，浏览器与 Node ≥ 18 都有。
 * `"deflate"` 这个格式名在 Compression Streams 规范里就是 zlib 封装
 * （`"deflate-raw"` 才是裸 deflate），正好是 PNG 要的。
 *
 * @param bytes 待压缩字节
 * @returns zlib 封装的压缩结果
 */
export async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error(
      "PNG 编码需要 CompressionStream（zlib 压缩）：当前运行环境没有这个 API。请在浏览器或 Node ≥ 18 下导出，或改用 FrameSequenceExporter 只拿原始 RGBA 像素。",
    );
  }
  const source = new Blob([bytes as unknown as BlobPart]);
  const stream = source.stream().pipeThrough(new CompressionStream("deflate"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
