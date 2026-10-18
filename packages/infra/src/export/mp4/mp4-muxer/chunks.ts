/** MP4 封装的数据契约：待写入的已编码帧、轨道声明与 chunk 布局。 */

/** 一个已编码视频帧（时间为微秒，与 WebCodecs 一致） */
export interface VideoChunkSpec {
  /** 已编码的 NAL 数据：每个 NAL 前带 4 字节大端长度（avcC 的 lengthSize 约定） */
  data: Uint8Array;
  /** 该帧的显示时间戳（微秒，相对片段起点，从 0 起算） */
  timestampUs: number;
  /** 该帧的显示时长（微秒），写入 stts；一帧的标称值为 `1e6 / fps` */
  durationUs: number;
  /** 是否关键帧（决定是否写入同步样本表 stss） */
  keyFrame: boolean;
}

/** 一个已编码音频帧（AAC-LC 原始帧，不含 ADTS 头） */
export interface AudioChunkSpec {
  /** 编码后的 AAC 访问单元字节（裸帧，已去掉 ADTS 头） */
  data: Uint8Array;
  /** 该帧覆盖的时长（微秒）；写入 stts 时换算成采样率刻度 */
  durationUs: number;
}

/** 视频轨声明 */
export interface VideoTrackSpec {
  /** 画面宽（像素），写入 tkhd / stsd */
  width: number;
  /** 画面高（像素），写入 tkhd / stsd */
  height: number;
  /** 解码器配置（avcC 负载，SPS/PPS） */
  avcC: Uint8Array;
}

/** 音频轨声明 */
export interface AudioTrackSpec {
  /** 采样率（赫兹），写入 mp4a 与 esds，并作为 stts 的时基 */
  sampleRate: number;
  /** 声道数，写入音频采样入口的通道计数 */
  channels: number;
  /** AudioSpecificConfig */
  asc: Uint8Array;
  /** 名义码率（bps），仅写入 esds 元数据 */
  bitrate: number;
}

/** 单轨数据在 mdat 中的位置（最小封装每轨单 chunk） */
export interface TrackLayout {
  /** 该轨第一个 chunk 相对文件起点的字节偏移（stco 的条目） */
  chunkOffset: number;
  /** 该轨的 chunk 数；最小封装恒为 1，无数据时为 0 */
  chunkCount: number;
}
