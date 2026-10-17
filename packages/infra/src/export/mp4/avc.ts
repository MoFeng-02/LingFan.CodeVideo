/**
 * AVC 解码参数：从 WebCodecs 的 decoderConfig.description 提取 SPS/PPS，
 * 并组装 avcC 盒负载（ISOBMFF 的 AVCDecoderConfigurationRecord）。
 */
import { concat, u16, u8 } from "./boxes";

/** 参数集：H.264 的单 SPS 与单 PPS */
export interface AvcParameterSets {
  sps: Uint8Array;
  pps: Uint8Array;
}

/**
 * 解析 decoderConfig.description。Chrome 给的是 AVCDecoderConfigurationRecord
 * （avcC 形态，首字节 version=1）；也兼容 Annex B（00 00 01 起始码）输入。
 * 多参数集取第一个；缺失则抛出——没有参数集的文件无法解码。
 */
export function extractParameterSets(desc: ArrayBuffer): AvcParameterSets {
  const raw = new Uint8Array(desc);
  return raw[0] === 1 ? fromAvcC(raw) : fromAnnexB(raw);
}

/** avcC：头 5 字节 + SPS 段 + PPS 段（每段 [u16 长度 + NAL]） */
function fromAvcC(raw: Uint8Array): AvcParameterSets {
  if (raw.length < 7) throw new Error("avcC：description 过短，无法解析");
  let i = 5;
  const spsCount = raw[i++]! & 0x1f;
  let sps: Uint8Array | undefined;
  for (let n = 0; n < spsCount; n++) {
    if (i + 2 > raw.length) throw new Error("avcC：SPS 段截断");
    const len = (raw[i]! << 8) | raw[i + 1]!;
    i += 2;
    if (i + len > raw.length) throw new Error("avcC：SPS 段越界");
    if (!sps) sps = raw.slice(i, i + len);
    i += len;
  }
  if (i + 3 > raw.length) throw new Error("avcC：PPS 段截断");
  const ppsCount = raw[i++]!;
  if (ppsCount < 1) throw new Error("avcC：没有 PPS");
  const ppsLen = (raw[i]! << 8) | raw[i + 1]!;
  i += 2;
  if (i + ppsLen > raw.length) throw new Error("avcC：PPS 段越界");
  const pps = raw.slice(i, i + ppsLen);
  return check({ sps, pps });
}

/** Annex B：按 00 00 01 切 NAL，取 nal_unit_type 7/8 */
function fromAnnexB(raw: Uint8Array): AvcParameterSets {
  const nalu: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i + 2 < raw.length; i++) {
    if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1) {
      if (start >= 0) nalu.push(raw.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0) nalu.push(raw.slice(start));
  const byType = (t: number) => nalu.find((n) => (n[0]! & 0x1f) === t);
  return check({ sps: byType(7), pps: byType(8) });
}

function check(ps: {
  sps: Uint8Array | undefined;
  pps: Uint8Array | undefined;
}): AvcParameterSets {
  if (!ps.sps || !ps.pps || ps.sps.length === 0 || ps.pps.length === 0)
    throw new Error(
      "avcC：decoderConfig 缺少 SPS/PPS（编码器未给出可解码的参数集）",
    );
  return { sps: ps.sps, pps: ps.pps };
}

/** 组装 avcC 盒负载：version + profile/level + 长度前缀的参数集 */
export function makeAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return concat([
    u8(0x01), // configurationVersion
    u8(sps[1] ?? 0), // AVCProfileIndication
    u8(sps[2] ?? 0), // profile_compatibility
    u8(sps[3] ?? 0), // AVCLevelIndication
    u8(0xfc | 3), // lengthSizeMinusOne = 3（4 字节长度前缀）
    u8(0xe0 | 1), // numOfSequenceParameterSets = 1
    u16(sps.length),
    sps,
    u8(1), // numOfPictureParameterSets = 1
    u16(pps.length),
    pps,
  ]);
}
