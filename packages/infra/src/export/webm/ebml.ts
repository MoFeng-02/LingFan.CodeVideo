/**
 * EBML 原语：变长整数（VINT）、元素 ID 的字节化、以及「ID + 长度 + 负载」的元素拼装。
 *
 * 与 MP4 的定长大端整数不同，EBML 的长度字段是**变长**的：首字节的前导零个数
 * 决定长度字段占几个字节，标记位之后的比特才是数值（所以 N 字节最多表达
 * `2^(7N) − 2` 而不是 `2^(8N) − 1`，全 1 留作「长度未知」）。元素 ID 本身
 * 已经是 VINT 形态，直接按字节写出即可，前面不再加长度前缀。
 *
 * 这里只做封装方向的构造，不做解析；每个原语都新建并返回 `Uint8Array`，
 * 调用方按需拼接。
 */

/**
 * 本模块产出的字节序列：底层缓冲一定是独享的 `ArrayBuffer`。
 *
 * 写这个别名是为了让返回值能直接作为 `Blob` 的分片——`Uint8Array` 泛型默认
 * 允许 `SharedArrayBuffer`，那样的视图进不了 `BlobPart`；而这里每个构造都
 * 用 `new Uint8Array(n)` 现分配，从不共享别人的缓冲。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * 把无符号整数写成 EBML 长度字段（VINT）。
 *
 * 取能装下该值的最短字节数；全 1 的组合保留给「长度未知」，因此 N 字节的
 * 上限是 `2^(7N) − 2`。
 *
 * @param value 要写的长度或数值（非负整数）
 * @returns 1..8 字节的变长整数
 */
export function vint(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`EBML 变长整数只接受非负整数：收到 ${value}`);
  for (let length = 1; length <= 8; length++) {
    /** 该长度下可表达的最大值（不给全 1 留位） */
    const max = 2 ** (7 * length) - 1;
    if (value >= max) continue;
    /** 输出缓冲：先把数值写成大端，再补首字节的长度标记 */
    const out = new Uint8Array(length);
    let rest = value;
    for (let i = length - 1; i >= 0; i--) {
      out[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    out[0] = out[0]! | (1 << (8 - length));
    return out;
  }
  throw new Error(`EBML 变长整数超出可表达范围：${value}`);
}

/**
 * 把元素 ID 转成字节。
 *
 * ID 自身带长度标记，所以字节数由数值量级决定（例如 `0xA3` 一字节、
 * `0x4286` 两字节、`0x1F43B675` 四字节），转换后原样写出。
 *
 * @param id 元素 ID（规范给出的十六进制值）
 * @returns ID 字节，长度 1..4
 */
export function elementId(id: number): Bytes {
  /** ID 的字节数：量级越过 8/16/24 位边界就多一字节 */
  const length = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  /** 输出缓冲 */
  const out = new Uint8Array(length);
  let rest = id;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

/**
 * 顺序拼接。
 *
 * 一次性分配总长再逐段 `set`，避免中间缓冲翻倍。
 *
 * @param parts 待拼接片段，按数组顺序拼接
 * @returns 新缓冲
 */
export function concatBytes(parts: readonly Uint8Array[]): Bytes {
  /** 拼接后的总长度 */
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  /** 新缓冲：不共享任何入参的底层内存 */
  const out = new Uint8Array(total);
  /** 当前写入偏移（字节） */
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 组一个元素：ID + 长度 + 负载。
 *
 * 长度按负载实际字节数写，因此嵌套元素可以直接拼接后再整体交给它。
 *
 * @param id 元素 ID
 * @param payload 负载字节
 * @returns 完整元素字节
 */
export function element(id: number, payload: Uint8Array): Bytes {
  return concatBytes([elementId(id), vint(payload.length), payload]);
}

/**
 * 组一个无符号整数元素（负载取最短大端表示）。
 *
 * @param id 元素 ID
 * @param value 无符号整数值
 * @returns 完整元素字节
 */
export function uintElement(id: number, value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`EBML 无符号整数元素只接受非负整数：收到 ${value}`);
  /** 负载字节数：至少 1，向上取到能装下该值的整字节 */
  let length = 1;
  while (length < 8 && value >= 2 ** (8 * length)) length++;
  /** 负载缓冲（大端） */
  const payload = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    payload[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return element(id, payload);
}

/**
 * 组一个浮点元素（8 字节双精度）。
 *
 * Matroska 的时长与采样率都是浮点，短格式没有收益，统一写双精度。
 *
 * @param id 元素 ID
 * @param value 浮点值
 * @returns 完整元素字节
 */
export function floatElement(id: number, value: number): Bytes {
  /** 8 字节负载缓冲 */
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, value, false);
  return element(id, payload);
}

/**
 * 组一个字符串元素（UTF-8，不带结尾 0）。
 *
 * @param id 元素 ID
 * @param value 文本
 * @returns 完整元素字节
 */
export function stringElement(id: number, value: string): Bytes {
  return element(id, new TextEncoder().encode(value));
}

/**
 * 组一个二进制元素。
 *
 * @param id 元素 ID
 * @param payload 负载字节
 * @returns 完整元素字节
 */
export function binaryElement(id: number, payload: Uint8Array): Bytes {
  return element(id, payload);
}

/**
 * 组一个主元素（负载是若干子元素的拼接）。
 *
 * @param id 元素 ID
 * @param children 子元素，按顺序拼接
 * @returns 完整元素字节
 */
export function masterElement(
  id: number,
  children: readonly Uint8Array[],
): Bytes {
  return element(id, concatBytes(children));
}

/**
 * 写一个有符号 16 位大端整数（块内的相对时间码）。
 *
 * 块时间码是相对簇时间码的有符号偏移，必须落在 −32768..32767。
 *
 * @param value 有符号整数
 * @returns 2 字节
 */
export function int16(value: number): Bytes {
  if (!Number.isInteger(value) || value < -32768 || value > 32767)
    throw new Error(`块相对时间码超出 int16 范围：${value}`);
  /** 2 字节缓冲（大端，补码写法与 DataView 一致） */
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, value, false);
  return out;
}
