/**
 * MP4 盒原语：Big-Endian 整数、8 字节头（长度 + fourcc）、字节拼接。
 * 只提供封装方向的构造，不做解析。
 */

/** 8 字节盒头：4 字节长度（含头）+ 4 字节类型 */
export function boxHeader(type: string, size: number): Uint8Array {
  const b = new Uint8Array(8);
  b.set(u32(size), 0);
  b.set(fourcc(type), 4);
  return b;
}

/** 组装盒：头 + 负载 */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((s, p) => s + p.length, 0);
  return concat([boxHeader(type, size), ...payload]);
}

/** fourcc 文本（4 字节 ASCII） */
export function fourcc(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  return out;
}

/** UTF-8 文本（hdlr 名称等） */
export function textOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** 无符号 8 位 */
export function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}

/** 无符号 16 位 */
export function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = (v >>> 8) & 0xff;
  b[1] = v & 0xff;
  return b;
}

/** 无符号 24 位 */
export function u24(v: number): Uint8Array {
  const b = new Uint8Array(3);
  b[0] = (v >>> 16) & 0xff;
  b[1] = (v >>> 8) & 0xff;
  b[2] = v & 0xff;
  return b;
}

/** 无符号 32 位 */
export function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

/** 16.16 定点数（tkhd 宽高、mp4a 采样率） */
export function fixed1616(v: number): Uint8Array {
  return u32(Math.round(v * 0x10000) >>> 0);
}

/** 全 0 占位字节 */
export function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

/** 顺序拼接 */
export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Uint8Array → 独立 ArrayBuffer（Blob 需要非 SharedArrayBuffer 视图） */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(
    u.byteOffset,
    u.byteOffset + u.byteLength,
  ) as ArrayBuffer;
}
