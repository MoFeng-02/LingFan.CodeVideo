/**
 * AVC 解码参数：从 WebCodecs 的 decoderConfig.description 提取 SPS/PPS，
 * 并组装 avcC 盒负载（ISOBMFF 的 AVCDecoderConfigurationRecord）。
 *
 * 只处理 H.264/AVC，多参数集场景取第一个 SPS 与 PPS；取不到可用参数集时
 * 一律抛错而不是产出无法解码的文件。这两个函数只做字节层面的转换，
 * 不接触编码器也不缓存，可在 `finalize` 阶段一次性调用。
 */
import { concat, u16, u8 } from "./boxes";

/** 参数集：H.264 的单 SPS 与单 PPS */
export interface AvcParameterSets {
  /** 序列参数集 NAL 的负载字节（不含起始码与长度前缀） */
  sps: Uint8Array;
  /** 图像参数集 NAL 的负载字节（不含起始码与长度前缀） */
  pps: Uint8Array;
}

/**
 * 解析 decoderConfig.description。Chrome 给的是 AVCDecoderConfigurationRecord
 * （avcC 形态，首字节 version=1）；也兼容 Annex B（00 00 01 起始码）输入。
 * 多参数集取第一个；缺失则抛出——没有参数集的文件无法解码。
 *
 * @param desc 编码器给出的解码器描述字节（`ArrayBuffer`）
 * @returns 第一个 SPS 与第一个 PPS
 */
export function extractParameterSets(desc: ArrayBuffer): AvcParameterSets {
  /** 描述的字节视图；首字节 1 表示 avcC 形态，否则按 Annex B 处理 */
  const raw = new Uint8Array(desc);
  return raw[0] === 1 ? fromAvcC(raw) : fromAnnexB(raw);
}

/**
 * avcC：头 5 字节 + SPS 段 + PPS 段（每段 [u16 长度 + NAL]）。
 *
 * @param raw avcC 形态的描述字节
 * @returns 取到的第一个 SPS/PPS
 */
function fromAvcC(raw: Uint8Array): AvcParameterSets {
  if (raw.length < 7) throw new Error("avcC：description 过短，无法解析");
  /** 读指针：跳过 5 字节固定头，指向 SPS 计数 */
  let i = 5;
  /** SPS 个数（低 5 位，高位是保留位） */
  const spsCount = raw[i++]! & 0x1f;
  /** 第一个 SPS；遍历时只保留第一个 */
  let sps: Uint8Array | undefined;
  for (let n = 0; n < spsCount; n++) {
    if (i + 2 > raw.length) throw new Error("avcC：SPS 段截断");
    /** 当前 SPS 的 NAL 字节长度 */
    const len = (raw[i]! << 8) | raw[i + 1]!;
    i += 2;
    if (i + len > raw.length) throw new Error("avcC：SPS 段越界");
    if (!sps) sps = raw.slice(i, i + len);
    i += len;
  }
  if (i + 3 > raw.length) throw new Error("avcC：PPS 段截断");
  /** PPS 个数（本实现只用第一个，但计数决定后面还有没有数据） */
  const ppsCount = raw[i++]!;
  if (ppsCount < 1) throw new Error("avcC：没有 PPS");
  /** 第一个 PPS 的 NAL 字节长度 */
  const ppsLen = (raw[i]! << 8) | raw[i + 1]!;
  i += 2;
  if (i + ppsLen > raw.length) throw new Error("avcC：PPS 段越界");
  const pps = raw.slice(i, i + ppsLen);
  return check({ sps, pps });
}

/**
 * Annex B：按 00 00 01 切 NAL，取 nal_unit_type 7/8。
 *
 * @param raw Annex B 形态的描述字节
 * @returns 按类型取到的第一个 SPS/PPS
 */
function fromAnnexB(raw: Uint8Array): AvcParameterSets {
  /** 切出来的 NAL 列表（按出现顺序） */
  const nalu: Uint8Array[] = [];
  /** 当前 NAL 负载起点；-1 表示还没遇到起始码 */
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

/**
 * 校验参数集齐备且非空。
 *
 * @param ps 可能缺失的 SPS/PPS
 * @returns 确认非空后的参数集
 */
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

/**
 * 组装 avcC 盒负载：version + profile/level + 长度前缀的参数集。
 *
 * profile / level 直接从 SPS 的第 2..4 字节取；长度前缀固定为 4 字节
 * （lengthSizeMinusOne = 3），与 muxer 写入样本时期望的格式一致。
 *
 * @param sps 序列参数集负载，至少 4 字节（取不到时相应字段写 0）
 * @param pps 图像参数集负载
 * @returns avcC 负载字节（不含盒头）
 */
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
