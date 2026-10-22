/**
 * APNG 逐帧导出器：把推演出的 CPU 位图原样封成带 alpha 的单文件动图。
 *
 * 它存在的理由是「透明帧要能变成一个真实的产物」：mp4/webcodecs 那条路走
 * H.264，编码格式本身没有 alpha 通道，把带透明的帧喂进去只会得到一片黑底。
 * APNG 是 PNG 的动画扩展，逐帧保留 RGBA 的 alpha，能在浏览器、设计工具、
 * 剪辑软件里直接当素材用，且不需要引入任何编码器依赖。
 *
 * 它只收 CPU 位图（和 `FrameSequenceExporter` 同样的取舍）：设备句柄不承诺
 * CPU 可读，而编码必须逐像素读，所以要透明产物就让宿主返回位图。
 * 音频不在这个格式里：APNG 没有音轨，有声音的剧本会在这里明确报错，
 * 而不是静默丢掉音轨。
 */

import type {
  ExportFormat,
  ExportResult,
  Exporter,
  ExporterImpl,
  FrameBitmap,
  FrameCarrier,
  Ms,
} from "@lingfan-video/contracts";

import { apngActl, apngFctl, apngFdat, concatBytes } from "./apng-chunks";
import {
  PNG_SIGNATURE,
  deflateZlib,
  pngChunk,
  pngIhdr,
  pngScanlines,
} from "./png";

/** 已经压好、还没写进文件的一帧：扫描线字节与该帧停留时长 */
interface PendingFrame {
  /** zlib 压缩后的扫描线 */
  scanlines: Uint8Array;
  /** 该帧在时间线上的时刻（毫秒） */
  timestampMs: Ms;
}

/**
 * APNG 导出器。
 *
 * 帧一到就压成数据块、立刻进文件字节序列，`finalize` 只补动画控制块与
 * 结尾标记。两处细节值得记下来：
 *
 * - `acTL`（总帧数）必须排在第一个 `IDAT` 之前，但帧数只有推进完才知道。
 *   这里不去攒整片来换这个数，而是在收尾时把 `acTL` 分块插到帧块前面——
 *   分块本身就是独立的字节块，拼装顺序由我们定，不需要提前知道总量。
 * - 每帧的 `fcTL` 要写停留时长，而时长取「下一帧时刻 − 本帧时刻」。所以
 *   只压住**一帧**：下一帧到达时立刻把上一帧写出去，收尾时再冲掉最后一帧。
 *
 * 产物由分块字节序列直接交给 `Blob`，不再拼一份等长的整片副本；分块序列
 * 本身仍随帧数增长（`Blob` 要能随机访问整份产物），所以它是「压缩后」的
 * 增长，不是「原始 RGBA × 帧数」的增长。
 */
export class ApngExporter implements Exporter {
  /** 实现标识 */
  readonly impl: ExporterImpl = "apng";
  /** 产物格式 */
  readonly format: ExportFormat = "apng";
  /** PNG 的 RGBA 像素逐帧原样压进产物，alpha 一路保留 */
  readonly alpha = true;

  private readonly width: number;
  private readonly height: number;
  /** 与帧数无关的头两块：签名与 IHDR */
  private readonly header: Uint8Array[];
  /** 逐帧写入的数据块（fcTL 与其后的 IDAT / fdAT），按到达顺序累积 */
  private readonly blocks: Uint8Array[] = [];
  /** 压好但还没写出去的那一帧（等下一帧的时刻来定它的停留时长） */
  private pending: PendingFrame | null = null;
  /** 上一帧写出去时用的停留时长：末帧沿用这个间隔 */
  private lastDelay = 0;
  /** 已写出的帧数 */
  private written = 0;
  /** 最后一个时刻：产物要报的总时长 */
  private lastTimestampMs: Ms = 0;
  /** 收尾拼出的分块序列；`finalize` 之前为 `null` */
  private parts: Uint8Array[] | null = null;

  /**
   * @param size 导出画面的像素尺寸；必须与每帧位图尺寸一致
   */
  constructor(size: { width: number; height: number }) {
    this.width = size.width;
    this.height = size.height;
    this.header = [PNG_SIGNATURE, pngIhdr(size.width, size.height)];
  }

  /**
   * 写入一帧：校验尺寸、折成扫描线压缩，并把上一帧真正落进文件。
   *
   * @param frame 帧载体；只接受 CPU 位图
   * @param timestampMs 该帧在时间线上的时刻（毫秒）
   */
  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    if (frame.kind === "handle") {
      throw new Error(
        "ApngExporter 需要 CPU 像素，而本帧是设备句柄（FrameHandle）：要出透明动画请让宿主返回位图（painter 侧回读），要出 mp4 请改用 WebCodecsExporter。",
      );
    }
    const bitmap = frame as FrameBitmap;
    if (bitmap.width !== this.width || bitmap.height !== this.height) {
      throw new Error(
        `ApngExporter 的帧尺寸不一致：导出器声明 ${this.width}×${this.height}，这一帧是 ${bitmap.width}×${bitmap.height}。`,
      );
    }
    const scanlines = pngScanlines(bitmap.data, this.width, this.height);
    const previous = this.pending;
    // 上一帧的停留时长现在才知道：它的终点是这一帧的起点
    if (previous)
      this.emit(previous, Math.round(timestampMs - previous.timestampMs));
    this.pending = { scanlines: await deflateZlib(scanlines), timestampMs };
    this.lastTimestampMs = timestampMs;
  }

  /**
   * 收尾：补上动画控制块与结尾标记，把分块序列交给产物。
   *
   * 首帧数据块用 `IDAT`（不认动画的解码器也能拿到静态首帧），其余用 `fdAT`；
   * 序号在 fcTL 与 fdAT 之间共享一条自增序列，从 0 起连续——这是 APNG 规范
   * 对序号的要求，缺号或重号会让解码器直接拒绝整份文件。
   *
   * @returns 导出的 APNG 产物
   */
  async finalize(): Promise<ExportResult> {
    const pending = this.pending;
    if (pending) this.emit(pending, this.lastDelay);
    this.pending = null;

    const parts: Uint8Array[] = [...this.header];
    // 总帧数到这里才是定值：把 acTL 插在帧块之前，不去攒整片换这一个数
    if (this.written > 0) parts.push(apngActl(this.written, 0));
    parts.push(...this.blocks);
    parts.push(pngChunk("IEND", new Uint8Array(0)));
    this.parts = parts;

    return {
      output: new Blob(parts as unknown as BlobPart[], { type: "image/apng" }),
      frames: this.written,
      durationMs: this.lastTimestampMs,
      format: "apng",
    };
  }

  /**
   * 生成的 APNG 字节；`finalize` 之前为 `null`。
   *
   * @returns APNG 文件字节
   */
  get fileBytes(): Uint8Array | null {
    return this.parts ? concatBytes(this.parts) : null;
  }

  /**
   * 把一帧写进数据块序列。
   *
   * @param entry 已压缩的一帧
   * @param delayMs 该帧的停留时长（毫秒）
   */
  private emit(entry: PendingFrame, delayMs: number): void {
    const first = this.written === 0;
    this.blocks.push(apngFctl(this.sequence, this.width, this.height, delayMs));
    this.sequence += 1;
    if (first) {
      this.blocks.push(pngChunk("IDAT", entry.scanlines));
    } else {
      this.blocks.push(apngFdat(this.sequence, entry.scanlines));
      this.sequence += 1;
    }
    this.written += 1;
    this.lastDelay = delayMs;
  }

  /** fcTL / fdAT 共享的自增序号，从 0 起连续 */
  private sequence = 0;
}
