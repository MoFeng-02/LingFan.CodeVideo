/**
 * 内存 FrameSink（CapturePort 适配器）：预览/测试用，帧全收内存不落盘。
 */
import type {
  FrameBitmap,
  FrameIndex,
  FrameSink,
  Ms,
} from "@lingfan-video/contracts";

export class MemoryFrameSink implements FrameSink {
  readonly frames: FrameBitmap[] = [];
  readonly indexes: FrameIndex[] = [];
  readonly timestamps: Ms[] = [];

  writeFrame(frame: FrameBitmap, index: FrameIndex, timestampMs: Ms): void {
    this.frames.push(frame);
    this.indexes.push(index);
    this.timestamps.push(timestampMs);
  }

  async finalize(): Promise<void> {
    /* 内存收集无需收尾 */
  }
}
