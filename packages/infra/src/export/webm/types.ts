/**
 * WebM 导出适配器的参数、轨道声明与编码块类型。
 *
 * 容器侧（`webm-muxer`）只认「已编码块的字节 + 时间戳」，编码侧
 * （`video-track` / `audio-track`）只认编码器与像素/采样格式，两者通过这些
 * 类型交接，互不依赖内部状态。
 */

/** 视频编解码器标识：VP8 支持 alpha 侧通道，VP9 只走不透明 */
export type WebmVideoCodec = "V_VP8" | "V_VP9";

/** 视频轨声明：尺寸、编解码器与是否携带 alpha 附加块 */
export interface WebmVideoSpec {
  /** 像素宽 */
  readonly width: number;
  /** 像素高 */
  readonly height: number;
  /** 编解码器标识（写进 `CodecID`） */
  readonly codec: WebmVideoCodec;
  /** 默认每帧时长（纳秒）；给出后播放器可直接推算帧率 */
  readonly defaultDurationNs?: number;
  /** 是否携带 alpha 附加块（写进 `AlphaMode`） */
  readonly alpha: boolean;
}

/** 音频轨声明：采样布局与编解码器私有数据 */
export interface WebmAudioSpec {
  /** 采样率（赫兹），写进 `SamplingFrequency` */
  readonly sampleRate: number;
  /** 声道数 */
  readonly channels: number;
  /** 编解码器私有数据（Opus 为 19 字节 `OpusHead`） */
  readonly codecPrivate: Uint8Array;
}

/** 已编码视频块：颜色数据 + 可选的 alpha 侧通道 */
export interface WebmVideoChunk {
  /** 颜色帧的编码字节 */
  readonly data: Uint8Array;
  /** 时间戳（微秒，单调不减） */
  readonly timestampUs: number;
  /** 该帧时长（微秒） */
  readonly durationUs: number;
  /** 是否关键帧（决定块类型与索引点位置） */
  readonly keyFrame: boolean;
  /** alpha 平面的编码字节；给出时这一帧走块组 + 附加块 */
  readonly alpha?: Uint8Array;
}

/** 已编码音频块 */
export interface WebmAudioChunk {
  /** 编码字节 */
  readonly data: Uint8Array;
  /** 时间戳（微秒，单调不减） */
  readonly timestampUs: number;
  /** 该块时长（微秒） */
  readonly durationUs: number;
}

/** WebM 导出参数 */
export interface WebmExporterOptions {
  /** 输出宽（像素）；位图帧的尺寸必须与之一致 */
  readonly width: number;
  /** 输出高（像素）；位图帧的尺寸必须与之一致 */
  readonly height: number;
  /** 帧率声明（仅用于编码器提示与轨道默认帧时长；实际时间戳来自帧） */
  readonly fps: number;
  /** 视频编码器：缺省 `vp9`（不透明） */
  readonly videoCodec?: "vp8" | "vp9";
  /** 是否让视频轨携带 alpha 侧通道；缺省 false */
  readonly alpha?: boolean;
  /** 视频码率（bps），缺省 3Mbps */
  readonly bitrate?: number;
  /** alpha 平面的码率（bps），缺省 1Mbps；只在透明档用 */
  readonly alphaBitrate?: number;
  /** 音频码率（bps），缺省 128kbps */
  readonly audioBitrate?: number;
}

/** 时间码单位（纳秒）：1ms 是 WebM 的通用取值，块内相对时间码以它为刻度 */
export const WEBM_TIMECODE_SCALE_NS = 1_000_000;
