/**
 * 帧指纹：只依赖像素与尺寸的确定性摘要（无平台 API、不受编码影响）。
 * 用途：确定性校验——同一次推演跑两遍，逐帧指纹必须完全相同；
 * 也用来判断「改了引擎但画面没动」（指纹序列不变）。
 *
 * 指纹是诊断用的弱摘要（非密码学哈希）：算得快、结果稳定，
 * 适合「是否同一帧」这类二值判断，不能当作防伪用途。
 */
import type { FrameBitmap } from "@lingfan-video/contracts";

/** FNV-1a 32 位偏移基准（规范常量） */
const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a 32 位乘数（规范常量） */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32：确定性、逐字节、无平台依赖。
 *
 * 缺点是对相似输入扩散不足，所以调用方用两个不同种子各算一遍再拼接。
 *
 * @param bytes 参与散列的字节（像素缓冲或尺寸头）
 * @param seed 起始摘要值（32 位无符号），用于派生不同路
 * @returns 32 位无符号摘要
 */
function fnv1a32(bytes: Uint8Array | Uint8ClampedArray, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 32 位摘要转 8 位小写十六进制文本。
 *
 * @param value 32 位无符号摘要
 * @returns 定长 8 字符，不足位补前导零（保证指纹总长恒定）
 */
function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/**
 * 帧指纹：16 位十六进制（双路 FNV-1a）。
 * 两路种子不同，单路碰撞需要同时碰撞两个 32 位摘要，诊断用途足够。
 *
 * 尺寸先于像素参与散列，所以「像素相同但尺寸不同」也会得到不同指纹。
 * 只读 `width` / `height` / `data`，不读 `kind`，因此 CPU 位图与从设备
 * 回读出来的同尺寸像素会得到相同指纹。
 *
 * @param frame CPU 位图（RGBA 四通道，长度需为 `width * height * 4`）
 * @returns 16 位小写十六进制字符串，同一输入恒定
 */
export function frameFingerprint(frame: FrameBitmap): string {
  /** 尺寸头：宽、高各 4 字节小端，先参与散列以免不同尺寸撞同一指纹 */
  const header = new Uint8Array(8);
  /** 尺寸头的整数视图：按小端写宽高，保证同一尺寸在不同平台得到同一字节序 */
  const view = new DataView(header.buffer);
  view.setUint32(0, frame.width, true);
  view.setUint32(4, frame.height, true);
  /** 以尺寸头的摘要作为像素散列的种子，使宽高不同即整段不同 */
  const seed = fnv1a32(header, FNV_OFFSET);
  /** 第一路 32 位摘要 */
  const first = fnv1a32(frame.data, seed);
  /** 第二路 32 位摘要：种子由第一路派生，两路一起碰撞才可能同指纹 */
  const second = fnv1a32(frame.data, (first ^ 0x9e3779b9) >>> 0);
  return hex8(first) + hex8(second);
}

/**
 * 帧指纹序列的摘要：整段推演一个值，用于「两次运行是否同一段」的快速判定。
 *
 * 按 8 位宽度把每个指纹的十六进制文本折成字节再散列，所以它只反映
 * 序列内容与顺序；帧数为 0 时返回空序列的摘要（不是空字符串）。
 *
 * @param fingerprints 逐帧指纹（`frameFingerprint` 的产物，按帧序）
 * @returns 16 位小写十六进制字符串；长度或顺序不同即不同
 */
export function sequenceFingerprint(fingerprints: readonly string[]): string {
  /** 每帧占 16 字节（一个指纹的文本长度），整体喂给散列 */
  const bytes = new Uint8Array(fingerprints.length * 16);
  for (let i = 0; i < fingerprints.length; i++) {
    /** 当前帧的十六进制文本 */
    const text = fingerprints[i]!;
    for (let j = 0; j < 16; j++) bytes[i * 16 + j] = text.charCodeAt(j) & 0xff;
  }
  /** 第一路 32 位摘要（种子为固定基准值，与逐帧指纹同一套做法） */
  const first = fnv1a32(bytes, FNV_OFFSET);
  /** 第二路 32 位摘要：种子由第一路派生，两路一起碰撞才可能同序列 */
  const second = fnv1a32(bytes, (first ^ 0x9e3779b9) >>> 0);
  return hex8(first) + hex8(second);
}
