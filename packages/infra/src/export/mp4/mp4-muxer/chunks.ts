/** MP4 封装的数据契约：待写入的已编码帧、轨道声明与 chunk 布局。 */

/** 一个已编码视频帧（时间为微秒，与 WebCodecs 一致） */
export interface VideoChunkSpec {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
  keyFrame: boolean;
}

/** 一个已编码音频帧（AAC-LC 原始帧，不含 ADTS 头） */
export interface AudioChunkSpec {
  data: Uint8Array;
  /** 该帧覆盖的时长（微秒）；写入 stts 时换算成采样率刻度 */
  durationUs: number;
}

/** 视频轨声明 */
export interface VideoTrackSpec {
  width: number;
  height: number;
  /** 解码器配置（avcC 负载，SPS/PPS） */
  avcC: Uint8Array;
}

/** 音频轨声明 */
export interface AudioTrackSpec {
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig */
  asc: Uint8Array;
  /** 名义码率（bps），仅写入 esds 元数据 */
  bitrate: number;
}

/** 单轨数据在 mdat 中的位置（最小封装每轨单 chunk） */
export interface TrackLayout {
  chunkOffset: number;
  chunkCount: number;
}
