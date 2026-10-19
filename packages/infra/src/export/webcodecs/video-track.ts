/**
 * 视频轨：H.264 编码器的生命周期与「帧载体 → VideoFrame」的转换。
 *
 * 编码器惰性创建（首帧才建），输出回调把编码块追加进容器，并从首个块的描述里
 * 取 SPS/PPS——封装 mp4 需要参数集。
 */
import type {
  FrameBitmap,
  FrameCarrier,
  FrameHandle,
} from "@lingfan-video/contracts";
import { extractParameterSets } from "../mp4";
import type { Mp4Muxer } from "../mp4";
import type { EncoderGate } from "./encoder-gate";
import type { WebCodecsExporterOptions } from "./types";

/** H.264 编码器与帧转换的持有者：一帧一帧喂给容器，收尾时 flush/close */
export class VideoTrack {
  /** 编码器：首帧时创建，收尾时关闭 */
  private encoder: VideoEncoder | null = null;
  /** H.264 SPS（从编码器 `decoderConfig.description` 提取）；缺则无法封装 */
  private spsBytes: Uint8Array | null = null;
  /** H.264 PPS，与 `spsBytes` 同时取得 */
  private ppsBytes: Uint8Array | null = null;

  /**
   * @param opts 导出参数（尺寸/帧率/码率）
   * @param muxer 容器写入器：编码块按到达顺序追加
   * @param gate 编码错误与背压的共用通道
   */
  constructor(
    private readonly opts: WebCodecsExporterOptions,
    private readonly muxer: Mp4Muxer,
    private readonly gate: EncoderGate,
  ) {}

  /** H.264 SPS；编码器尚未输出参数集时为 `null` */
  get sps(): Uint8Array | null {
    return this.spsBytes;
  }

  /** H.264 PPS；与 SPS 同时取得 */
  get pps(): Uint8Array | null {
    return this.ppsBytes;
  }

  /**
   * 编码一帧（不等待出队；背压由调用方随后 `drain`）。
   *
   * 帧载体里的原生对象可能是 VideoFrame，也可能是任意可作图像源的画布；
   * 位图帧需要拷一次到 VideoFrame（它本来就是 CPU 像素）。
   *
   * @param frame 帧载体：句柄（设备侧对象/画布）或位图
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
    this.ensureEncoder();
    /** 交给编码器的一帧：时间戳/时长按时间线重建，内容借用原载体 */
    const videoFrame = this.frameToVideoFrame(frame, timestampUs, durationUs);
    try {
      this.encoder!.encode(videoFrame, { keyFrame });
    } finally {
      videoFrame.close();
    }
  }

  /** 等编码队列降到上限以下（背压；编码错误同样会在这里抛出） */
  async drain(): Promise<void> {
    await this.gate.drain(this.encoder!);
  }

  /** flush 并关闭编码器（只在存在时操作；收尾失败后可重试） */
  async flushAndClose(): Promise<void> {
    if (!this.encoder) return;
    await this.encoder.flush();
    this.gate.throwIfFailed();
    this.encoder.close();
    this.encoder = null;
  }

  /** 载体 → VideoFrame：位图必须校验尺寸并拷贝一次，句柄则借用设备侧对象 */
  private frameToVideoFrame(
    frame: FrameCarrier,
    timestampUs: number,
    durationUs: number,
  ): VideoFrame {
    if (frame.kind === "handle") {
      /** 句柄里的原生对象：可能是 VideoFrame，也可能是任意可作图像源的画布 */
      const source = (frame as FrameHandle).native as
        VideoFrame | CanvasImageSource;
      if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
        return new VideoFrame(source, {
          timestamp: timestampUs,
          duration: durationUs,
        });
      }
      return new VideoFrame(source as CanvasImageSource, {
        timestamp: timestampUs,
        duration: durationUs,
      });
    }
    /** 位图帧：数据已是 RGBA 像素，按视图本身交给编码器（保留 byteOffset/byteLength） */
    const bitmap: FrameBitmap = frame;
    if (bitmap.width !== this.opts.width || bitmap.height !== this.opts.height)
      throw Object.assign(
        new Error(
          `WebCodecsExporter：位图尺寸 ${bitmap.width}×${bitmap.height} 与导出尺寸 ` +
            `${this.opts.width}×${this.opts.height} 不一致`,
        ),
        { name: "SpecViolation" },
      );
    if (bitmap.data.byteLength !== bitmap.width * bitmap.height * 4)
      throw Object.assign(
        new Error(
          `WebCodecsExporter：位图数据 ${bitmap.data.byteLength} 字节 ≠ ` +
            `${bitmap.width}×${bitmap.height}×4`,
        ),
        { name: "SpecViolation" },
      );
    return new VideoFrame(bitmap.data, {
      format: "RGBA",
      codedWidth: this.opts.width,
      codedHeight: this.opts.height,
      timestamp: timestampUs,
      duration: durationUs,
    });
  }

  /** 惰性创建并配置视频编码器（H.264 baseline，`avc` 格式输出长度前缀参数集） */
  private ensureEncoder(): void {
    if (this.encoder) return;
    /** 视频编码器：输出回调把编码块追加进容器，并从首个块的描述里取 SPS/PPS */
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        /** 编码器给的解码器配置描述；首个块才带 SPS/PPS */
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.spsBytes) {
          /** 从解码器描述里拆出的参数集 */
          const ps = extractParameterSets(desc as ArrayBuffer);
          this.spsBytes = ps.sps;
          this.ppsBytes = ps.pps;
        }
        this.muxer.addVideo({
          data: copyBytes(chunk),
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 0,
          keyFrame: chunk.type === "key",
        });
      },
      error: (e) =>
        this.gate.fail(new Error(`VideoEncoder 错误：${e.message}`)),
    });
    encoder.configure({
      codec: "avc1.42001f",
      width: this.opts.width,
      height: this.opts.height,
      bitrate: this.opts.bitrate ?? 8_000_000,
      framerate: this.opts.fps,
      // avc 格式（长度前缀）才能直接进 mp4；annexb 需要额外转换
      avc: { format: "avc" },
    });
    this.encoder = encoder;
  }
}

/** EncodedChunk 数据拷贝（chunk 的 buffer 由编码器复用） */
function copyBytes(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  /** 拷贝目标：编码器的缓冲会被复用，必须自己留一份 */
  const out = new Uint8Array(new ArrayBuffer(chunk.byteLength));
  chunk.copyTo(out.buffer);
  return out;
}
