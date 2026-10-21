/**
 * 块与簇：WebM 里「一帧画面 / 一块音频」的实际落点。
 *
 * 块有两种形态：
 * - `SimpleBlock`：自带关键帧标志位，不携带附加数据——不透明视频与音频走它；
 * - `BlockGroup`：块本体 + `BlockAdditions`（alpha 侧通道）+ `ReferenceBlock`
 *   ——带透明的视频走它。原因是 `SimpleBlock` 的关键帧标志位与附加数据不能
 *   同时使用，关键帧与否只能由「有没有 `ReferenceBlock`」表达。
 *
 * 簇是可跳转的最小单位：块的相对时间码是相对簇时间码的有符号 16 位偏移，
 * 所以一个簇的时间跨度必须留在 ±32.7 秒以内。
 */
import { concatBytes, element, int16, vint } from "./ebml";
import {
  BLOCK,
  BLOCK_ADDITIONS,
  BLOCK_ADDITIONAL,
  BLOCK_ADD_ID,
  BLOCK_GROUP,
  BLOCK_MORE,
  CLUSTER,
  REFERENCE_BLOCK,
  SIMPLE_BLOCK,
  TIMECODE,
} from "./ids";

/** 块头里不带 lacing 的固定标志位 */
const NO_LACING = 0x00;
/** `SimpleBlock` 的关键帧标志位（最高位） */
const KEY_FRAME_BIT = 0x80;
/** alpha 附加数据的编号：WebM alpha 规范里 1 表示 alpha 平面 */
export const ALPHA_BLOCK_ADD_ID = 1;

/** 簇里的一块：容器侧只需知道轨道、相对时间码与编码字节 */
export interface ClusterBlock {
  /** 轨道编号（1 = 视频，2 = 音频） */
  readonly trackNumber: number;
  /** 相对簇时间码的偏移（毫秒） */
  readonly relativeMs: number;
  /** 是否关键帧 */
  readonly keyFrame: boolean;
  /** 编码字节 */
  readonly data: Uint8Array;
  /** alpha 平面的编码字节；给出时这一块走块组 */
  readonly alpha?: Uint8Array;
}

/**
 * 块头：轨道号（变长）+ 相对时间码（有符号 16 位）+ 标志位。
 *
 * @param trackNumber 轨道编号
 * @param relativeMs 相对簇时间码的偏移（毫秒）
 * @param keyFrame 是否关键帧（只对 `SimpleBlock` 有意义）
 * @returns 块头字节
 */
export function blockHeader(
  trackNumber: number,
  relativeMs: number,
  keyFrame: boolean,
): Uint8Array {
  return concatBytes([
    vint(trackNumber),
    int16(relativeMs),
    new Uint8Array([(keyFrame ? KEY_FRAME_BIT : 0) | NO_LACING]),
  ]);
}

/**
 * 组一个 `SimpleBlock`：不携带附加数据时的块。
 *
 * @param block 块内容
 * @returns 完整元素字节
 */
export function simpleBlock(block: ClusterBlock): Uint8Array {
  return element(
    SIMPLE_BLOCK,
    concatBytes([
      blockHeader(block.trackNumber, block.relativeMs, block.keyFrame),
      block.data,
    ]),
  );
}

/**
 * 组一个 `BlockGroup`：块本体 + alpha 附加数据 + 参考块声明。
 *
 * @param block 块内容（必须带 `alpha`）
 * @param referenceMs 相对本块时间码的参考偏移（非正数，指向簇内最近关键帧）
 * @returns 完整元素字节
 */
export function blockGroup(
  block: ClusterBlock,
  referenceMs: number,
): Uint8Array {
  if (!block.alpha)
    throw new Error("块组需要 alpha 附加数据：不透明块应走 SimpleBlock");
  /** 块本体：与 SimpleBlock 同样的头，但没有关键帧标志位 */
  const body = element(
    BLOCK,
    concatBytes([
      blockHeader(block.trackNumber, block.relativeMs, false),
      block.data,
    ]),
  );
  /** alpha 侧通道：编号 1 + alpha 平面的编码字节 */
  const additions = element(
    BLOCK_ADDITIONS,
    element(
      BLOCK_MORE,
      concatBytes([
        element(BLOCK_ADD_ID, vint(ALPHA_BLOCK_ADD_ID)),
        element(BLOCK_ADDITIONAL, block.alpha),
      ]),
    ),
  );
  /** 子元素：块本体、附加数据，非关键帧再补一条参考块 */
  const children = [body, additions];
  if (!block.keyFrame)
    children.push(element(REFERENCE_BLOCK, signedPayload(referenceMs)));
  return element(BLOCK_GROUP, concatBytes(children));
}

/**
 * 组一个簇：时间码 + 若干块。
 *
 * @param timecodeMs 簇时间码（毫秒，绝对时刻）
 * @param blocks 块列表，按相对时间码升序
 * @returns 完整元素字节
 */
export function cluster(
  timecodeMs: number,
  blocks: readonly ClusterBlock[],
): Uint8Array {
  /** 每条轨道最近一次关键帧的相对时间码（写参考块时要用） */
  const lastKey = new Map<number, number>();
  /** 块元素，按给出顺序拼接 */
  const parts: Uint8Array[] = [element(TIMECODE, uintPayload(timecodeMs))];
  for (const block of blocks) {
    /** 参考偏移：指向本轨道在簇内最近的关键帧 */
    const keyMs = lastKey.get(block.trackNumber) ?? block.relativeMs;
    if (block.alpha) parts.push(blockGroup(block, block.relativeMs - keyMs));
    else parts.push(simpleBlock(block));
    if (block.keyFrame) lastKey.set(block.trackNumber, block.relativeMs);
  }
  return element(CLUSTER, concatBytes(parts));
}

/**
 * 无符号整数负载的最短大端表示。
 *
 * @param value 非负整数
 * @returns 1..8 字节
 */
export function uintPayload(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`WebM 无符号整数只接受非负整数：收到 ${value}`);
  /** 负载字节数：至少 1，向上取到能装下该值的整字节 */
  let length = 1;
  while (length < 8 && value >= 2 ** (8 * length)) length++;
  return signedPayload(value, length);
}

/**
 * 有符号整数的补码表示（`ReferenceBlock` 等元素用）。
 *
 * @param value 有符号整数
 * @param byteLength 指定字节数；省略时取能装下该值的最短长度
 * @returns 1..8 字节大端补码
 */
export function signedPayload(value: number, byteLength?: number): Uint8Array {
  if (!Number.isSafeInteger(value))
    throw new Error(`WebM 有符号整数只接受安全整数：收到 ${value}`);
  /** 字节数：给定值优先，否则取能装下该值的最短长度 */
  const length = byteLength ?? pickSignedLength(value);
  /** 输出缓冲（大端补码，与 DataView 写法一致） */
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  if (length === 1) view.setInt8(0, value);
  else if (length === 2) view.setInt16(0, value, false);
  else if (length === 4) view.setInt32(0, value, false);
  else {
    /** 非 1/2/4 字节：高位按符号位补齐，低位逐字节写入 */
    const negative = value < 0;
    let rest = Math.abs(value);
    for (let i = length - 1; i >= 0; i--) {
      out[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    if (negative) {
      for (let i = 0; i < length; i++) out[i] = ~out[i]! & 0xff;
      for (let i = length - 1, carry = 1; i >= 0 && carry; i--) {
        const next = out[i]! + carry;
        out[i] = next & 0xff;
        carry = next > 0xff ? 1 : 0;
      }
    }
  }
  return out;
}

/**
 * 选能装下该有符号值的最短字节数。
 *
 * @param value 有符号整数
 * @returns 1、2、4 或 8
 */
function pickSignedLength(value: number): number {
  if (value >= -128 && value <= 127) return 1;
  if (value >= -32768 && value <= 32767) return 2;
  if (value >= -2147483648 && value <= 2147483647) return 4;
  return 8;
}
