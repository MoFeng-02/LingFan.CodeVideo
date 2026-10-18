/**
 * 内存 FrameSink（CapturePort 适配器）：预览/测试用，帧全收内存不落盘。
 *
 * 用途：把一段推演的产物留在进程里供断言或再处理（例如喂给诊断指纹、
 * 预览回放），不需要文件系统也不需要编码器。收帧是同步的、无背压——
 * 每帧都会被保存，调用方要自己控制帧数，长片高分辨率会持续占内存。
 *
 * 只接受 CPU 位图（`FrameCarrier` 里的 `kind` 不是 `"handle"` 的那个分支）：
 * 设备句柄代表一块由渲染端持有的设备资源，内存收集既不能复制也不能替
 * 调用方释放，所以遇到句柄直接报错而不是静默丢帧。
 */
import type {
  FrameBitmap,
  FrameCarrier,
  FrameIndex,
  FrameSink,
  Ms,
} from "@lingfan-video/contracts";

/**
 * 只收 CPU 位图的内存收集器，实现 `FrameSink` 供推演管线注入。
 *
 * 三个数组按下标一一对应：`frames[i]` 是第 `indexes[i]` 帧、时间戳为
 * `timestamps[i]`。写入顺序即收帧顺序；`finalize()` 不做任何事，
 * 收完直接读数组即可。
 */
export class MemoryFrameSink implements FrameSink {
  /** 收下的帧（与 `indexes` / `timestamps` 同序等长） */
  readonly frames: FrameBitmap[] = [];
  /** 每帧的帧号（从 0 开始，由上游给出） */
  readonly indexes: FrameIndex[] = [];
  /** 每帧的时间戳（毫秒，由上游按 fps 推出的时间轴位置） */
  readonly timestamps: Ms[] = [];

  /**
   * 收一帧：位图原样入数组，不复制像素（调用方之后不应再改这块数据）。
   *
   * @param frame 帧载体；只接受 CPU 位图，设备句柄会抛错
   * @param index 帧号（从 0 开始），原样记录
   * @param timestampMs 时间戳（毫秒），原样记录
   */
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

  /** 收尾：内存收集没有待落盘的内容，直接完成 */
  async finalize(): Promise<void> {
    /* 内存收集无需收尾 */
  }
}
