/**
 * AAC 声明：AudioSpecificConfig（ASC）与 mp4a 所需的 esds 盒。
 * ASC 优先用编码器给的 decoderConfig.description；缺失时按采样率/声道数自行合成。
 *
 * 这两个函数只构造声明字节，不做编码、不读写音频样本；样本数据由封装层
 * （muxer）按块索引写入。合成 ASC 只在编码器没给 `description` 时使用，
 * 采样率不在标准表内时返回 `null`，由调用方 fail-fast——不会猜一个近似值。
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
 *
 * 位布局：5 位对象类型 | 4 位采样率索引 | 4 位声道配置 | 3 位尾零。
 *
 * @param sampleRate 采样率（赫兹），必须是表内 13 个标准值之一
 * @param channels 声道数，按 AAC channelConfiguration 语义写入（1 = 单声道，2 = 立体声）
 * @returns 2 字节 ASC；采样率不支持时返回 `null`
 */
export function makeAacConfig(
  sampleRate: number,
  channels: number,
): Uint8Array | null {
  /** 采样率索引（0..12）；表外采样率为 `undefined` */
  const rateIndex = RATE_INDEX[sampleRate];
  if (rateIndex === undefined) return null;
  /** 打包后的 16 位声明值（大端写出） */
  const value = (2 << 11) | (rateIndex << 7) | (channels << 3);
  return u16(value);
}

/**
 * esds 盒：ES_Descriptor → DecoderConfigDescriptor(objectType 0x40 = MPEG-4 Audio)
 * → DecoderSpecificInfo(ASC) → SLConfigDescriptor。
 * 播放器据此把 mp4a 样本解成 AAC-LC。
 *
 * 码率只写进声明（maxBitrate / avgBitrate 用同一个值），不参与实际编码控制。
 *
 * @param asc AudioSpecificConfig 字节（编码器提供的 description，或 `makeAacConfig` 的产物）
 * @param bitrate 音频码率（比特每秒），写入 maxBitrate 与 avgBitrate
 * @returns 完整的 `esds` 盒字节（含盒头）
 */
export function makeEsds(asc: Uint8Array, bitrate: number): Uint8Array {
  /** DecoderSpecificInfo（tag 0x05）：承载 ASC */
  const decSpecific = descriptor(0x05, asc);
  /** DecoderConfigDescriptor（tag 0x04）：对象类型、流类型、码率与 ASC */
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
  /** SLConfigDescriptor（tag 0x06）：预定义 2 = MP4 默认同步层 */
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

/**
 * MPEG-4 描述符：tag + 变长长度（本例长度均 < 128，单字节足够；大长度用 4 字节形式）。
 *
 * @param tag 描述符标签（如 0x03 ES、0x04 DecoderConfig、0x05 DecSpecific、0x06 SLConfig）
 * @param payload 描述符负载字节
 * @returns tag + 长度 + 负载
 */
function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  /** 负载长度（字节） */
  const len = payload.length;
  /** 长度字段：< 128 用单字节，否则用 4 字节变长形式（高位续位标志） */
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
