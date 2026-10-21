/**
 * WebM 视频轨：VP8/VP9 编码器的生命周期、帧载体 → VideoFrame 的转换，以及透明档
 * 的 alpha 侧通道。
 *
 * 透明在 WebM 里不是一个像素格式，而是一条**并行的关键帧流**：alpha 平面被单独
 * 编成一串只含关键帧的画面（alpha 值放在亮度平面），再以 `BlockAdditions` 挂在
 * 同一块上。所以透明档要开第二个编码器，两路按时间戳配对后一起交给容器。
 *
 * 侧通道必须读逐像素 alpha，因此透明档只收 CPU 位图：设备句柄不承诺 CPU 可读，
 * 导出器不得回读像素——回读属于帧来源侧的选择（见 `createReadbackHost`）。
 *
 * 编码器惰性创建：不透明档只开一个，透明档首帧才开第二个。
 */
import type {
  FrameBitmap,
  FrameCarrier,
  FrameHandle,
} from "@lingfan-video/contracts";
import type { EncoderGate } from "../encoder-gate";
import { copyChunkBytes } from "../encoded-chunk";
import type { WebmExporterOptions, WebmVideoChunk } from "./types";

/** WebCodecs 的编解码器串：VP8 直接用短名，VP9 走完整 profile 串 */
const CODEC_STRING = {
  vp8: "vp8",
  vp9: "vp09.00.10.08",
} as const;

/** 已编码的颜色帧：等 alpha 平面到达后一起交出 */
interface PendingColor {
  /** 颜色帧的编码字节 */
  readonly data: Uint8Array;
  /** 该帧时长（微秒） */
  readonly durationUs: number;
  /** 是否关键帧 */
  readonly keyFrame: boolean;
}

/** 视频轨：配色编码器，一帧一帧喂给容器，收尾时 flush/close */
export class WebmVideoTrack {
  /** 颜色编码器：首帧时创建，收尾时关闭 */
  private encoder: VideoEncoder | null = null;
  /** alpha 编码器：透明档首帧时创建，收尾时关闭 */
  private alphaEncoder: VideoEncoder | null = null;
  /** 已到达但还在等 alpha 平面的颜色块，按时间戳索引 */
  private readonly colors = new Map<number, PendingColor>();
  /** 已到达但还在等颜色块的 alpha 平面，按时间戳索引 */
  private readonly alphas = new Map<number, Uint8Array>();

  /**
   * @param opts 导出参数（尺寸/码率/帧率提示/是否透明）
   * @param onChunk 编码块的落点（容器或配对缓冲）
   * @param gate 编码错误与背压的共用通道
   */
  constructor(
    private readonly opts: WebmExporterOptions,
    private readonly onChunk: (chunk: WebmVideoChunk) => void,
    private readonly gate: EncoderGate,
  ) {}

  /** 是否走透明档（侧通道） */
  private get wantsAlpha(): boolean {
    return this.opts.alpha === true;
  }

  /**
   * 编码一帧（不等待出队；背压由调用方随后 `drain`）。
   *
   * @param frame 帧载体：不透明档句柄与位图都收，透明档只收位图
   * @param timestampUs 该帧时间戳（微秒，单调不减）
   * @param durationUs 该帧时长（微秒）
   * @param keyFrame 是否关键帧
   */
  encode(
    frame: FrameCarrier,
    timestampUs: number,
    durationUs: number,
    keyFrame: boolean,
  ): void {
    if (this.wantsAlpha && frame.kind === "handle")
      throw Object.assign(
        new Error(
          "WebmExporter 的透明档需要逐像素 alpha，而本帧是设备句柄（FrameHandle）：" +
            "句柄不承诺 CPU 可读，导出器也不回读像素。" +
            "要透明产物请让帧来源交位图（painter 侧回读，例如 createReadbackHost），" +
            '要零拷贝出片请把 alpha 声明改成 "opaque"。',
        ),
        { name: "SpecViolation" },
      );
    this.ensureEncoder();
    /** 交给颜色编码器的一帧：时间戳/时长按时间线重建，内容借用原载体 */
    const videoFrame = toVideoFrame(frame, this.opts, timestampUs, durationUs);
    try {
      this.encoder!.encode(videoFrame, { keyFrame });
    } finally {
      videoFrame.close();
    }
    if (this.wantsAlpha) this.encodeAlphaPlane(frame, timestampUs, durationUs);
  }

  /** 等编码队列降到上限以下（背压；编码错误同样会在这里抛出） */
  async drain(): Promise<void> {
    if (this.encoder) await this.gate.drain(this.encoder);
    if (this.alphaEncoder) await this.gate.drain(this.alphaEncoder);
  }

  /**
   * flush 并关闭两个编码器，并检查两路是否配齐。
   *
   * 颜色块与 alpha 平面必须一一对应：少一面就意味着这一帧要么没有画面、要么
   * 透明信息错位，容器不做猜测，直接报错。
   */
  async flushAndClose(): Promise<void> {
    if (this.encoder) {
      await this.encoder.flush();
      this.gate.throwIfFailed();
      this.encoder.close();
      this.encoder = null;
    }
    if (this.alphaEncoder) {
      await this.alphaEncoder.flush();
      this.gate.throwIfFailed();
      this.alphaEncoder.close();
      this.alphaEncoder = null;
    }
    /** 两路剩下的未配对帧数（不透明档不配对，恒为 0） */
    const leftover = this.wantsAlpha ? this.colors.size + this.alphas.size : 0;
    if (leftover > 0)
      throw new Error(
        `WebM 透明轨：${this.colors.size} 个颜色块与 ${this.alphas.size} 个 alpha 平面没有配对` +
          "（同一帧的两路编码必须都到达）",
      );
  }

  /** 惰性创建并配置颜色编码器 */
  private ensureEncoder(): void {
    if (this.encoder) return;
    /** 视频编码器：输出回调把编码块交给配对逻辑 */
    const encoder = new VideoEncoder({
      output: (chunk) =>
        this.acceptColor(chunk.timestamp, {
          data: copyChunkBytes(chunk),
          durationUs: chunk.duration ?? 0,
          keyFrame: chunk.type === "key",
        }),
      error: (e) =>
        this.gate.fail(new Error(`VideoEncoder 错误：${e.message}`)),
    });
    encoder.configure({
      codec: CODEC_STRING[this.opts.videoCodec ?? "vp9"],
      width: this.opts.width,
      height: this.opts.height,
      bitrate: this.opts.bitrate ?? 3_000_000,
      framerate: this.opts.fps,
    });
    this.encoder = encoder;
  }

  /**
   * 把一帧的 alpha 平面编成一条关键帧。
   *
   * alpha 流按规范只含关键帧，所以这里每帧都要求 `keyFrame: true`；画面把 alpha
   * 复制到 RGB 三通道，编码后亮度平面即 alpha 值。
   *
   * @param frame 帧载体（透明档已保证是位图）
   * @param timestampUs 该帧时间戳（微秒）
   * @param durationUs 该帧时长（微秒）
   */
  private encodeAlphaPlane(
    frame: FrameCarrier,
    timestampUs: number,
    durationUs: number,
  ): void {
    this.ensureAlphaEncoder();
    /** alpha 平面画面：RGB 三通道都填 alpha 值，亮度即 alpha */
    const gray = alphaPlane(frame as FrameBitmap);
    /** 交给 alpha 编码器的一帧 */
    const videoFrame = new VideoFrame(gray, {
      format: "RGBA",
      codedWidth: this.opts.width,
      codedHeight: this.opts.height,
      timestamp: timestampUs,
      duration: durationUs,
    });
    try {
      this.alphaEncoder!.encode(videoFrame, { keyFrame: true });
    } finally {
      videoFrame.close();
    }
  }

  /** 惰性创建并配置 alpha 编码器（与颜色轨同尺寸同编解码器，码率更低） */
  private ensureAlphaEncoder(): void {
    if (this.alphaEncoder) return;
    /** alpha 编码器：输出回调把平面交给配对逻辑 */
    const encoder = new VideoEncoder({
      output: (chunk) =>
        this.acceptAlpha(chunk.timestamp, copyChunkBytes(chunk)),
      error: (e) =>
        this.gate.fail(
          new Error(`VideoEncoder（alpha 平面）错误：${e.message}`),
        ),
    });
    encoder.configure({
      codec: CODEC_STRING[this.opts.videoCodec ?? "vp9"],
      width: this.opts.width,
      height: this.opts.height,
      bitrate: this.opts.alphaBitrate ?? 1_000_000,
      framerate: this.opts.fps,
    });
    this.alphaEncoder = encoder;
  }

  /**
   * 收到一个颜色块。
   *
   * 不透明档没有侧通道要等，直接交出；透明档等同一时刻的 alpha 平面到了再一起交。
   *
   * @param timestampUs 该块时间戳（微秒）
   * @param pending 待配对的颜色块内容
   */
  private acceptColor(timestampUs: number, pending: PendingColor): void {
    if (!this.wantsAlpha) {
      this.emit(pending, timestampUs);
      return;
    }
    /** 同刻到达的 alpha 平面 */
    const alpha = this.alphas.get(timestampUs);
    if (alpha) {
      this.alphas.delete(timestampUs);
      this.emit(pending, timestampUs, alpha);
      return;
    }
    this.colors.set(timestampUs, pending);
  }

  /**
   * 收到一个 alpha 平面：颜色块已在就一并交出，否则挂着等。
   *
   * @param timestampUs 该平面时间戳（微秒）
   * @param data 平面编码字节
   */
  private acceptAlpha(timestampUs: number, data: Uint8Array): void {
    /** 同刻到达的颜色块 */
    const color = this.colors.get(timestampUs);
    if (color) {
      this.colors.delete(timestampUs);
      this.emit(color, timestampUs, data);
      return;
    }
    this.alphas.set(timestampUs, data);
  }

  /**
   * 交出一帧（颜色块 + 可选 alpha 平面）。
   *
   * @param color 颜色块内容
   * @param timestampUs 该帧时间戳（微秒）
   * @param alpha alpha 平面编码字节；不透明档省略
   */
  private emit(
    color: PendingColor,
    timestampUs: number,
    alpha?: Uint8Array,
  ): void {
    this.onChunk({
      data: color.data,
      timestampUs,
      durationUs: color.durationUs,
      keyFrame: color.keyFrame,
      ...(alpha ? { alpha } : {}),
    });
  }
}

/**
 * 从 RGBA 位图抽出 alpha 平面并铺成灰度画面。
 *
 * WebM 的 alpha 侧通道把 alpha 值放在亮度平面，所以三通道填同一个值即可让
 * 编码器的 RGB→YUV 转换得到 Y ≈ alpha。
 *
 * @param bitmap 源位图（RGBA 交错）
 * @returns 与源同尺寸的灰度画面（RGBA，alpha 通道不透明）
 */
function alphaPlane(bitmap: FrameBitmap): Uint8ClampedArray {
  /** 源像素字节 */
  const src = bitmap.data;
  /** 输出画面：每个像素 RGB 都填 alpha，A 填 255 */
  const out = new Uint8ClampedArray(new ArrayBuffer(src.length));
  for (let i = 0; i < src.length; i += 4) {
    /** 该像素的 alpha 值 */
    const a = src[i + 3]!;
    out[i] = a;
    out[i + 1] = a;
    out[i + 2] = a;
    out[i + 3] = 255;
  }
  return out;
}

/**
 * 帧载体 → VideoFrame：位图校验尺寸后整块交出，句柄按设备侧对象包装。
 *
 * @param frame 帧载体
 * @param opts 导出参数（尺寸用于校验与编码器配置）
 * @param timestampUs 该帧时间戳（微秒）
 * @param durationUs 该帧时长（微秒）
 * @returns 可直接交给编码器的一帧（调用方负责 close）
 */
export function toVideoFrame(
  frame: FrameCarrier,
  opts: { width: number; height: number },
  timestampUs: number,
  durationUs: number,
): VideoFrame {
  if (frame.kind === "handle") {
    /** 句柄里的原生对象：可能是 VideoFrame，也可能是任意可作图像源的画布 */
    const source = (frame as FrameHandle).native as
      VideoFrame | CanvasImageSource;
    if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame)
      return new VideoFrame(source, {
        timestamp: timestampUs,
        duration: durationUs,
      });
    return new VideoFrame(source as CanvasImageSource, {
      timestamp: timestampUs,
      duration: durationUs,
    });
  }
  /** 位图帧：数据已是 RGBA 像素，按视图本身交给编码器（保留 byteOffset） */
  const bitmap: FrameBitmap = frame;
  assertBitmapSize(bitmap, opts.width, opts.height);
  return new VideoFrame(bitmap.data, {
    format: "RGBA",
    codedWidth: opts.width,
    codedHeight: opts.height,
    timestamp: timestampUs,
    duration: durationUs,
  });
}

/**
 * 校验位图尺寸与数据长度（宽高在图里、长度在字节数里，两者都可能写错）。
 *
 * @param bitmap 待校验位图
 * @param width 期望宽（像素）
 * @param height 期望高（像素）
 */
export function assertBitmapSize(
  bitmap: FrameBitmap,
  width: number,
  height: number,
): void {
  if (bitmap.width !== width || bitmap.height !== height)
    throw Object.assign(
      new Error(
        `位图尺寸 ${bitmap.width}×${bitmap.height} 与导出尺寸 ${width}×${height} 不一致`,
      ),
      { name: "SpecViolation" },
    );
  if (bitmap.data.byteLength !== width * height * 4)
    throw Object.assign(
      new Error(
        `位图数据 ${bitmap.data.byteLength} 字节 ≠ ${width}×${height}×4`,
      ),
      { name: "SpecViolation" },
    );
}
