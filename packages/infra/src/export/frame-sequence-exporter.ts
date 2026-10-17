/**
 * frames 导出适配器（Exporter 的 'frames' 实现）：位图序列原样收集在内存，
 * finalize 出 JSON 元数据 Blob。编码型适配器（WebCodecs/FFmpeg）按同一契约另行提供。
 */
import type {
  ExportResult,
  Exporter,
  FrameBitmap,
  Ms,
} from "@lingfan-video/contracts";

interface CapturedFrame {
  frame: FrameBitmap;
  timestampMs: Ms;
}

export class FrameSequenceExporter implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  private readonly captured: CapturedFrame[] = [];

  async writeFrame(frame: FrameBitmap, timestampMs: Ms): Promise<void> {
    this.captured.push({ frame, timestampMs });
  }

  async finalize(): Promise<ExportResult> {
    const last = this.captured[this.captured.length - 1];
    const durationMs: Ms = last ? last.timestampMs : 0;
    const meta = JSON.stringify({
      format: "frames",
      frames: this.captured.length,
      durationMs,
    });
    return {
      output: new Blob([meta], { type: "application/json" }),
      frames: this.captured.length,
      durationMs,
      format: "frames",
    };
  }

  /** 测试/预览便利：直接取已捕获位图（infra 侧能力，不属契约） */
  get frames(): readonly FrameBitmap[] {
    return this.captured.map((c) => c.frame);
  }

  /** 测试便利：时间戳序列（应严格等于 timestampAt(i, fps) 递增） */
  get timestamps(): readonly Ms[] {
    return this.captured.map((c) => c.timestampMs);
  }
}
