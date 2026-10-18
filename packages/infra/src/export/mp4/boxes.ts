/**
 * MP4 盒原语：Big-Endian 整数、8 字节头（长度 + fourcc）、字节拼接。
 * 只提供封装方向的构造，不做解析。
 *
 * 约定：所有多字节整数按 MP4 规范用大端写；`box` 返回的字节里长度字段
 * 已包含 8 字节头，因此嵌套盒可以直接拼接再整体加头。这里没有流式写入，
 * 每个原语都新建并返回 `Uint8Array`，调用方按需 `concat`。
 */

/**
 * 8 字节盒头：4 字节长度（含头）+ 4 字节类型。
 *
 * @param type 盒类型，取前 4 个字符作 fourcc（更短的类型会读出不足 4 字节）
 * @param size 整个盒的总字节数（头 + 负载），写成 32 位大端
 * @returns 8 字节盒头
 */
export function boxHeader(type: string, size: number): Uint8Array {
  /** 盒头缓冲：前 4 字节长度、后 4 字节类型 */
  const b = new Uint8Array(8);
  b.set(u32(size), 0);
  b.set(fourcc(type), 4);
  return b;
}

/**
 * 组装盒：头 + 负载。
 *
 * 总长度由负载累加得出，所以调用方不必自己算 size。
 *
 * @param type 盒类型（fourcc 文本）
 * @param payload 负载片段，按给出顺序拼接；可为空（只写盒头）
 * @returns 完整盒字节
 */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  /** 总长度 = 8 字节头 + 各负载长度之和 */
  const size = 8 + payload.reduce((s, p) => s + p.length, 0);
  return concat([boxHeader(type, size), ...payload]);
}

/**
 * fourcc 文本（4 字节 ASCII）。
 *
 * @param type 盒类型文本；只取前 4 个字符的低字节，超出部分忽略
 * @returns 4 字节，不足位以 0 补齐
 */
export function fourcc(type: string): Uint8Array {
  /** 固定 4 字节输出，短类型余下字节保持 0 */
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  return out;
}

/**
 * UTF-8 文本（hdlr 名称等）。
 *
 * @param s 待编码文本
 * @returns UTF-8 字节，长度不固定
 */
export function textOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * 无符号 8 位。
 *
 * @param v 整数；超出 0..255 的部分按低 8 位截断
 * @returns 1 字节
 */
export function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}

/**
 * 无符号 16 位（大端）。
 *
 * @param v 整数；超出 0..65535 的部分按低 16 位截断
 * @returns 2 字节
 */
export function u16(v: number): Uint8Array {
  /** 2 字节缓冲（大端） */
  const b = new Uint8Array(2);
  b[0] = (v >>> 8) & 0xff;
  b[1] = v & 0xff;
  return b;
}

/**
 * 无符号 24 位（大端）。
 *
 * @param v 整数；超出 0..16777215 的部分按低 24 位截断
 * @returns 3 字节
 */
export function u24(v: number): Uint8Array {
  /** 3 字节缓冲（大端） */
  const b = new Uint8Array(3);
  b[0] = (v >>> 16) & 0xff;
  b[1] = (v >>> 8) & 0xff;
  b[2] = v & 0xff;
  return b;
}

/**
 * 无符号 32 位（大端）。
 *
 * @param v 整数；负数与超出 32 位的值按无符号回绕写低 32 位
 * @returns 4 字节
 */
export function u32(v: number): Uint8Array {
  /** 4 字节缓冲（大端） */
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

/**
 * 16.16 定点数（tkhd 宽高、mp4a 采样率）。
 *
 * 先四舍五入再截断，所以小数部分按最近值舍入，不做截尾。
 *
 * @param v 实际值（如像素宽高、采样率赫兹）
 * @returns 4 字节大端定点数
 */
export function fixed1616(v: number): Uint8Array {
  return u32(Math.round(v * 0x10000) >>> 0);
}

/**
 * 全 0 占位字节。
 *
 * @param n 字节数（非负）
 * @returns 长度为 `n` 的零填充缓冲
 */
export function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

/**
 * 顺序拼接。
 *
 * 一次性分配总长度再逐段 `set`，避免中间缓冲翻倍。
 *
 * @param parts 待拼接片段，按数组顺序拼接
 * @returns 新缓冲，长度为各片段长度之和；空数组返回长度 0 的缓冲
 */
export function concat(parts: Uint8Array[]): Uint8Array {
  /** 拼接后的总长度 */
  const total = parts.reduce((s, p) => s + p.length, 0);
  /** 新缓冲：不共享任何入参的底层内存 */
  const out = new Uint8Array(total);
  /** 当前写入偏移（字节） */
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Uint8Array → 独立 ArrayBuffer（Blob 需要非 SharedArrayBuffer 视图）。
 *
 * 会复制一份字节：即使入参是更大缓冲的视图，返回的 ArrayBuffer 也只含
 * 该视图覆盖的区间。
 *
 * @param u 任意字节视图
 * @returns 与 `u` 内容相同的独立 ArrayBuffer
 */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(
    u.byteOffset,
    u.byteOffset + u.byteLength,
  ) as ArrayBuffer;
}
