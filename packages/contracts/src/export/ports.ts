import type { Ms } from "../shared/units";
import type { FrameCarrier } from "../capture";

/**
 * 导出格式（封装/复用归实现内部）。
 *
 * `mp4`/`webm` 是带音轨的成片封装，`frames` 是逐帧产物，
 * `apng` 是保 alpha 的单文件动图封装——透明产物走它。
 */
export type ExportFormat = "mp4" | "webm" | "frames" | "apng";

/** 实现标注：组合根按它选适配器 */
export type ExporterImpl = "webcodecs" | "ffmpeg" | "frames" | "apng";

/** 导出结果：产物位置/句柄与本次导出的统计 */
export interface ExportResult {
  /** 帧序列模式为目录/文件路径；编码模式为封装文件路径或 Blob */
  output: string | Blob;
  /** 实际写出的帧数 */
  frames: number;
  /** 成片时长（毫秒） */
  durationMs: Ms;
  /** 产物格式，与 Exporter.format 一致 */
  format: ExportFormat;
}

/**
 * 导出器契约：编码 + 封装一条龙；只认帧载体与音频样本，不认渲染端。
 * writeAudio 缺省 = 纯视频导出。
 *
 * 帧载体有两种：设备侧句柄（画布/纹理，零拷贝，交给 `VideoFrame` 即用）
 * 与 CPU 位图。实现要么两种都接，要么明确抛错——不许静默回读像素降级。
 * 句柄的生命周期归引擎：`writeFrame` 返回后引擎立即释放，实现不得跨帧持有。
 *
 * 写入纪律：帧与音频块都必须在 finalize 之前写完（封装需要完整元数据），
 * 且音频块按时间顺序连续提交；样本布局取 AudioClock 的采样率/声道声明。
 */
export interface Exporter {
  /** 实现标识：组合根据此选择适配器 */
  readonly impl: ExporterImpl;
  /** 产物格式 */
  readonly format: ExportFormat;
  /**
   * 写入一帧。
   * @param frame 设备句柄或 CPU 位图（所有权见类型说明）
   * @param timestampMs 该帧在时间线上的时刻（毫秒）
   */
  writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void>;
  /** 交错 Float32 PCM（长度 = 帧数 × channels）；块序列自 0 起连续，拼接即整轨 */
  writeAudio?(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void>;
  /** 收尾：写完元数据并返回导出结果；调用后不得再写入 */
  finalize(): Promise<ExportResult>;
}
