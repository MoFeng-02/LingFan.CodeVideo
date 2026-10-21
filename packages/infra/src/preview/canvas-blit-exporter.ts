/**
 * 把「设备侧帧」贴到一块可见画布上的导出器装饰器。
 *
 * 预览消费链的缺口在这里合上：多后端合成出的帧是 `FrameHandle`（画布/纹理），
 * 而 `PacedPreviewExporter` 只负责按音频时钟排帧、不消费像素——于是画面停在了
 * 底图上。这个装饰器在排帧之后把合成结果贴回舞台，预览与导出看到的就是同一张画面。
 *
 * 它不做任何重绘，也不解释后端：`handle.native` 能交给 `drawImage` 就贴，
 * 位图载体才走一次 `putImageData`（这是唯一会碰 CPU 像素的路径，且只在预览/定格）。
 */
import type {
  ExportFormat,
  ExportResult,
  Exporter,
  ExporterImpl,
} from "@lingfan-video/contracts";
import type { FrameCarrier, Ms } from "@lingfan-video/contracts";
import { isFrameHandle } from "../frames/carrier";

/**
 * 语义：**先让内核排帧/判停，再把这一帧贴到目标画布**。
 * 内核抛错（例如定格命中）时也要先贴，否则停住的画面会是上一帧。
 *
 * 能力面照抄内层：装饰器不凭空多出「能收音轨」这种声明。
 * 预览用的节拍导出器本来就没有音轨通道（声音走 AudioOutput 实时发声），
 * 若这里硬塞一个 writeAudio，组合根会误判成「有音轨出口但没给时钟」而拒绝推演。
 */
export class CanvasBlitExporter implements Exporter {
  /** 实现标识，原样照抄内层（预览路径通常是 `frames`） */
  readonly impl: ExporterImpl;
  /** 产物格式标识，原样照抄内层 */
  readonly format: ExportFormat;
  /** 产物是否带 alpha，同样照抄内层：贴帧不改变产物的透明度能力 */
  readonly alpha?: boolean;
  /** 仅当内层接受音频块时存在 */
  readonly writeAudio?: (
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ) => Promise<void>;
  /** 目标画布的 2D 上下文；目标拿不到上下文时为 `null`（贴帧变成空操作） */
  private readonly target: CanvasRenderingContext2D | null;
  /** 位图路径复用的临时 ImageData，尺寸变化时重建（避免每帧分配） */
  private staging: ImageData | null = null;

  /**
   * @param inner 被装饰的导出器：负责排帧、判停与产出结果，本节拍器不改变它的行为
   * @param target 贴帧目标画布；内部只取一次 2D 上下文
   */
  constructor(
    private readonly inner: Exporter,
    target: HTMLCanvasElement | OffscreenCanvas,
  ) {
    this.impl = inner.impl;
    this.format = inner.format;
    if (inner.alpha !== undefined) this.alpha = inner.alpha;
    this.target = (target as HTMLCanvasElement).getContext(
      "2d",
    ) as CanvasRenderingContext2D | null;
    if (inner.writeAudio) {
      this.writeAudio = (samples, sampleRate, channels) =>
        inner.writeAudio!(samples, sampleRate, channels);
    }
  }

  /**
   * 先交给内层处理，再贴帧；内层抛错时也贴完再抛。
   *
   * 内层返回的 Promise 在这里被 await，所以排帧等待（背压）仍然生效，
   * 贴帧只是同步追加的一步，不额外引入延迟。
   *
   * @param frame 本帧载体
   * @param timestampMs 本帧时间戳（毫秒）
   */
  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    try {
      await this.inner.writeFrame(frame, timestampMs);
    } catch (error) {
      this.present(frame);
      throw error;
    }
    this.present(frame);
  }

  /** 收尾：直接转交内层，装饰器自己不产出产物 */
  finalize(): Promise<ExportResult> {
    return this.inner.finalize();
  }

  /**
   * 把一帧贴到目标画布（同步、不等待 GPU）。
   *
   * @param frame 待显示的帧；句柄走 `drawImage`，位图走 `putImageData`
   */
  private present(frame: FrameCarrier): void {
    /** 目标 2D 上下文；没有则整段跳过 */
    const g = this.target;
    if (!g) return;
    if (isFrameHandle(frame)) {
      // 舞台此刻还留着上一步绘制时的变换（剧本按设计空间放大过）：
      // 不先复位就会把合成结果再放大一遍，画面上是原图的左上角。
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      g.drawImage(frame.native as CanvasImageSource, 0, 0);
      g.restore();
      return;
    }
    // 位图载体：把像素铺到目标画布（预览里通常只有一像素的占位，不做重活）
    /** 位图路径的三个必需字段：RGBA 像素、宽、高（像素） */
    const { data, width, height } = frame;
    if (width <= 0 || height <= 0) return;
    if (
      !this.staging ||
      this.staging.width !== width ||
      this.staging.height !== height
    ) {
      this.staging = g.createImageData(width, height);
    }
    this.staging.data.set(data);
    g.putImageData(this.staging, 0, 0);
  }
}
