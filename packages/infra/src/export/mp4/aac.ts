/**
 * AAC 声明：AudioSpecificConfig（ASC）与 mp4a 所需的 esds 盒。
 * ASC 优先用编码器给的 decoderConfig.description；缺失时按采样率/声道数自行合成。
 */
import { box, concat, u16, u32, u8, u24 } from "./boxes";

/** 采样频率索引表（ISO/IEC 14496-3） */
const RATE_INDEX: Readonly<Record<number, number>> = {
  96000: 0,
  88200: 1,
  64000: 2,
  48000: 3,
  44100: 4,
  32000: 5,
  24000: 6,
  22050: 7,
  16000: 8,
  12000: 9,
  11025: 10,
  8000: 11,
  7350: 12,
};

/**
 * 合成 ASC：AAC-LC（音频对象类型 2）+ 采样率索引 + 声道配置。
 * 仅当编码器未提供 description 时使用；采样率不在表内返回 null（调用方 fail-fast）。
 */
export function makeAacConfig(
  sampleRate: number,
  channels: number,
): Uint8Array | null {
  const rateIndex = RATE_INDEX[sampleRate];
  if (rateIndex === undefined) return null;
  const value = (2 << 11) | (rateIndex << 7) | (channels << 3);
  return u16(value);
}

/**
 * esds 盒：ES_Descriptor → DecoderConfigDescriptor(objectType 0x40 = MPEG-4 Audio)
 * → DecoderSpecificInfo(ASC) → SLConfigDescriptor。
 * 播放器据此把 mp4a 样本解成 AAC-LC。
 */
export function makeEsds(asc: Uint8Array, bitrate: number): Uint8Array {
  const decSpecific = descriptor(0x05, asc);
  const decoderConfig = descriptor(
    0x04,
    concat([
      u8(0x40), // objectTypeIndication：MPEG-4 Audio
      u8(0x15), // streamType：audioStream(5) << 2 | upStream(0) | reserved(1)
      u24(0), // bufferSizeDB：解码缓冲要求，0 = 未声明
      u32(bitrate), // maxBitrate
      u32(bitrate), // avgBitrate
      decSpecific,
    ]),
  );
  const slConfig = descriptor(0x06, u8(0x02));
  return box(
    "esds",
    u32(0), // version + flags
    descriptor(
      0x03,
      concat([
        u16(0), // ES_ID
        u8(0), // 优先级/依赖标志
        decoderConfig,
        slConfig,
      ]),
    ),
  );
}

/** MPEG-4 描述符：tag + 变长长度（本例长度均 < 128，单字节足够；大长度用 4 字节形式） */
function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const size =
    len < 0x80
      ? u8(len)
      : concat([
          u8(0x80 | ((len >>> 21) & 0x7f)),
          u8((len >>> 14) & 0xff),
          u8((len >>> 7) & 0xff),
          u8(len & 0x7f),
        ]);
  return concat([u8(tag), size, payload]);
}
