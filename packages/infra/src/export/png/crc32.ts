/**
 * PNG 分块校验用的 CRC-32（ISO 3309 / PNG 规范附录 D 的多项式 0xEDB88320）。
 *
 * PNG 每个分块的最后一个字段是该分块「类型 + 负载」的 CRC-32。查表只在首次
 * 使用时建一次：一张 720p 的帧要算几十万字节，逐位算法会明显拖慢导出。
 */

/** 查表缓存；`null` 表示尚未构建 */
let table: Uint32Array | null = null;

/**
 * 取（必要时构建）CRC-32 查表。
 *
 * @returns 256 项查表
 */
function crcTable(): Uint32Array {
  if (table) return table;
  const next = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    next[n] = c >>> 0;
  }
  table = next;
  return next;
}

/**
 * 算一段字节的 CRC-32。
 *
 * @param bytes 待校验字节
 * @returns 无符号 32 位校验值
 */
export function crc32(bytes: Uint8Array): number {
  const lookup = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (c ^ (bytes[i] as number)) & 0xff;
    c = (lookup[idx] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
