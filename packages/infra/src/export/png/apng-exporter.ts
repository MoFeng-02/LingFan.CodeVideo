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

/** 已压好的一帧：扫描线字节与该帧停留时长 */
interface EncodedFrame {
  /** zlib 压缩后的扫描线 */
  scanlines: Uint8Array;
  /** 该帧在时间线上的时刻（毫秒） */
  timestampMs: Ms;
}

/**
 * APNG 导出器。
 *
 * 帧在 `writeFrame` 时压缩并缓存（一次内存驻留），`finalize` 时才拼出文件头
 * 与动画控制块——因为 `acTL` 要求提前声明总帧数，而总帧数只有推演结束才知道。
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
  private readonly encoded: EncodedFrame[] = [];
  private bytes: Uint8Array | null = null;

  /**
   * @param size 导出画面的像素尺寸；必须与每帧位图尺寸一致
   */
  constructor(size: { width: number; height: number }) {
    this.width = size.width;
    this.height = size.height;
  }

  /**
   * 写入一帧：校验尺寸、折成扫描线并压缩缓存。
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
    this.encoded.push({
      scanlines: await deflateZlib(scanlines),
      timestampMs,
    });
  }

  /**
   * 收尾：拼出 PNG 签名、IHDR、acTL、逐帧 fcTL/IDAT/fdAT 与 IEND。
   *
   * 首帧数据块用 `IDAT`（不认动画的解码器也能拿到静态首帧），其余用 `fdAT`；
   * 序号在 fcTL 与 fdAT 之间共享一条自增序列，从 0 起连续——这是 APNG 规范
   * 对序号的要求，缺号或重号会让解码器直接拒绝整份文件。
   *
   * @returns 导出的 APNG 产物
   */
  async finalize(): Promise<ExportResult> {
    const first = this.encoded[0];
    const parts: Uint8Array[] = [
      PNG_SIGNATURE,
      pngIhdr(this.width, this.height),
    ];
    if (first) {
      parts.push(apngActl(this.encoded.length, 0));
    }
    let sequence = 0;
    for (let i = 0; i < this.encoded.length; i++) {
      const entry = this.encoded[i] as EncodedFrame;
      parts.push(
        apngFctl(sequence++, this.width, this.height, this.delayAfter(i)),
      );
      parts.push(
        i === 0
          ? pngChunk("IDAT", entry.scanlines)
          : apngFdat(sequence++, entry.scanlines),
      );
    }
    parts.push(pngChunk("IEND", new Uint8Array(0)));
    this.bytes = concatBytes(parts);
    const last = this.encoded[this.encoded.length - 1];
    return {
      output: new Blob([this.bytes as unknown as BlobPart], {
        type: "image/apng",
      }),
      frames: this.encoded.length,
      durationMs: last ? last.timestampMs : 0,
      format: "apng",
    };
  }

  /**
   * 生成的 APNG 字节；`finalize` 之前为 `null`。
   *
   * @returns APNG 文件字节
   */
  get fileBytes(): Uint8Array | null {
    return this.bytes;
  }

  /**
   * 算第 `index` 帧之后的停留时长。
   *
   * 时长取「下一帧时刻 − 本帧时刻」，所以变帧率的采样网格能原样表达；
   * 末帧没有后继，沿用前一帧的间隔；只有一帧时停留 0（单帧动画没有时长）。
   *
   * @param index 帧下标
   * @returns 停留时长（毫秒）
   */
  private delayAfter(index: number): number {
    const current = this.encoded[index] as EncodedFrame;
    const next = this.encoded[index + 1];
    if (next) return Math.round(next.timestampMs - current.timestampMs);
    const previous = this.encoded[index - 1];
    if (previous) {
      return Math.round(current.timestampMs - previous.timestampMs);
    }
    return 0;
  }
}
