/**
 * frames 导出适配器（Exporter 的 'frames' 实现）：位图序列原样收集在内存，
 * finalize 出 JSON 元数据 Blob。编码型适配器（WebCodecs/FFmpeg）按同一契约另行提供。
 *
 * 产物不是视频文件：`finalize` 返回的 Blob 只含 `{ format, frames, durationMs }`
 * 三个字段的 JSON，像素本身留在本对象里（`frames` / `timestamps` 两个 getter），
 * 由调用方决定怎么落盘。这条路径不引入编码器，因此不依赖浏览器能力、
 * 也没有异步编码时序与背压问题；代价是内存随帧数线性增长，长片不适合。
 */
import type {
  ExportResult,
  Exporter,
  FrameBitmap,
  FrameCarrier,
  Ms,
} from "@lingfan-video/contracts";

/** 一次收帧的内部记录：位图 + 该帧的时间戳 */
interface CapturedFrame {
  /** CPU 位图，原样持有（不复制像素） */
  frame: FrameBitmap;
  /** 时间戳（毫秒），来自上游时间轴 */
  timestampMs: Ms;
}

/**
 * 帧序列导出器：把逐帧位图按顺序收进内存，收尾时给出帧数与时长。
 *
 * 用法：作为 `Exporter` 注入推演管线，逐帧 `writeFrame`，最后 `finalize`。
 * 只接受 CPU 位图——设备句柄无法在内存里保留，遇到即报错；要出片请换
 * `WebCodecsExporter`，要取像素请让宿主侧回读成位图。
 */
export class FrameSequenceExporter implements Exporter {
  /** 实现标识：本适配器是纯 JS 的帧序列收集，不经过编码器 */
  readonly impl = "frames" as const;
  /** 产物格式标识：与 `ExportResult.format` 对应 */
  readonly format = "frames" as const;
  /** 已收帧（按写入顺序，长度 = 帧数） */
  private readonly captured: CapturedFrame[] = [];

  /**
   * 收一帧（同步入数组，无背压、不丢帧）。
   *
   * @param frame 帧载体；只接受 CPU 位图，设备句柄抛错
   * @param timestampMs 该帧在推演时间轴上的位置（毫秒）
   */
  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    if (frame.kind === "handle")
      throw new Error(
        "FrameSequenceExporter 需要 CPU 像素，而本帧是设备句柄（FrameHandle）：" +
          "要取像素请让宿主返回位图（painter 侧回读），要出片请改用 WebCodecsExporter。",
      );
    this.captured.push({ frame, timestampMs });
  }

  /**
   * 收尾并给出结果：不再编码，只汇总元数据。
   *
   * 时长取最后一帧的时间戳（首帧从 0 起算，故最后一帧时间戳即覆盖时长）；
   * 一帧未收时帧数与时长都是 0。可重复调用，结果相同（不会清空已收帧）。
   *
   * @returns 导出结果；`output` 是 JSON 元数据 Blob，`format` 恒为 `"frames"`
   */
  async finalize(): Promise<ExportResult> {
    /** 最后一帧（用于取整段时长）；空序列为 `undefined` */
    const last = this.captured[this.captured.length - 1];
    /** 整段时长（毫秒）：最后一帧的时间戳，无帧时为 0 */
    const durationMs: Ms = last ? last.timestampMs : 0;
    /** 元数据 JSON：只描述帧数与时长，像素不入 Blob */
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

  /** 测试便利：时间戳序列（变帧率下为采样网格点，非均匀） */
  get timestamps(): readonly Ms[] {
    return this.captured.map((c) => c.timestampMs);
  }
}
