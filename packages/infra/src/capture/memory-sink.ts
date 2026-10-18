/**
 * 内存 FrameSink（CapturePort 适配器）：预览/测试用，帧全收内存不落盘。
 */
import type {
  FrameBitmap,
  FrameCarrier,
  FrameIndex,
  FrameSink,
  Ms,
} from "@lingfan-video/contracts";

export class MemoryFrameSink implements FrameSink {
  readonly frames: FrameBitmap[] = [];
  readonly indexes: FrameIndex[] = [];
  readonly timestamps: Ms[] = [];

  writeFrame(frame: FrameCarrier, index: FrameIndex, timestampMs: Ms): void {
    if (frame.kind === "handle")
      throw new Error(
        "MemoryFrameSink 只收 CPU 位图：本帧是设备句柄（FrameHandle），" +
          "内存收集无法持有设备资源。",
      );
    this.frames.push(frame);
    this.indexes.push(index);
    this.timestamps.push(timestampMs);
  }

  async finalize(): Promise<void> {
    /* 内存收集无需收尾 */
  }
}
