/**
 * 帧指纹：只依赖像素与尺寸的确定性摘要（无平台 API、不受编码影响）。
 * 用途：确定性校验——同一次推演跑两遍，逐帧指纹必须完全相同；
 * 也用来判断「改了引擎但画面没动」（指纹序列不变）。
 */
import type { FrameBitmap } from "@lingfan-video/contracts";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32：确定性、逐字节、无平台依赖 */
function fnv1a32(bytes: Uint8Array | Uint8ClampedArray, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/**
 * 帧指纹：16 位十六进制（双路 FNV-1a）。
 * 两路种子不同，单路碰撞需要同时碰撞两个 32 位摘要，诊断用途足够。
 */
export function frameFingerprint(frame: FrameBitmap): string {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, frame.width, true);
  view.setUint32(4, frame.height, true);
  const seed = fnv1a32(header, FNV_OFFSET);
  const first = fnv1a32(frame.data, seed);
  const second = fnv1a32(frame.data, (first ^ 0x9e3779b9) >>> 0);
  return hex8(first) + hex8(second);
}

/** 帧指纹序列的摘要：整段推演一个值，用于「两次运行是否同一段」的快速判定 */
export function sequenceFingerprint(fingerprints: readonly string[]): string {
  const bytes = new Uint8Array(fingerprints.length * 16);
  for (let i = 0; i < fingerprints.length; i++) {
    const text = fingerprints[i]!;
    for (let j = 0; j < 16; j++) bytes[i * 16 + j] = text.charCodeAt(j) & 0xff;
  }
  const first = fnv1a32(bytes, FNV_OFFSET);
  const second = fnv1a32(bytes, (first ^ 0x9e3779b9) >>> 0);
  return hex8(first) + hex8(second);
}
