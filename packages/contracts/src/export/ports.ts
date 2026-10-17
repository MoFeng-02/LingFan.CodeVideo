import type { Ms } from "../shared/units";
import type { FrameBitmap } from "../capture";

/** 导出格式（封装/复用归实现内部） */
export type ExportFormat = "mp4" | "webm" | "frames";

/** 实现标注：组合根按它选适配器 */
export type ExporterImpl = "webcodecs" | "ffmpeg" | "frames";

export interface ExportResult {
  /** 帧序列模式为目录/文件路径；编码模式为封装文件路径或 Blob */
  output: string | Blob;
  frames: number;
  durationMs: Ms;
  format: ExportFormat;
}

/**
 * 导出器契约：编码 + 封装一条龙；只认帧位图与音频样本，不认渲染端。
 * writeAudio 缺省 = 纯视频导出。
 */
export interface Exporter {
  readonly impl: ExporterImpl;
  readonly format: ExportFormat;
  writeFrame(frame: FrameBitmap, timestampMs: Ms): Promise<void>;
  writeAudio?(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void>;
  finalize(): Promise<ExportResult>;
}
