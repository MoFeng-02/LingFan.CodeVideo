/**
 * WebM 导出适配器（Exporter 的 'webm' 实现）：VP8/VP9 视频 + Opus 音频，
 * 由 `WebmMuxer` 封装为 `.webm`。仅浏览器环境可用（WebCodecs 为平台 API）。
 *
 * 与其他导出路径的差别：
 * - `webcodecs` 出 mp4（H.264 + AAC），结构上没有 alpha 通道；
 * - 本文件出 WebM，透明档用 VP8/VP9 的 alpha 侧通道（`BlockAdditions`）装下
 *   逐像素透明度，产物仍是**单个带音轨的成片文件**；
 * - `apng` 出逐帧保 alpha 的动图，无音轨、无编码器参与；
 * - `frames` 留逐帧原始位图。
 *
 * 透明档的额外要求：alpha 侧通道必须读逐像素值，所以帧来源必须是位图
 * （`createReadbackHost` 可把交句柄的宿主包成位图）。导出器不回读像素。
 *
 * 写入顺序：所有帧与音频块都必须在 finalize 之前写完（容器要一次性算准段长度
 * 与索引偏移）。编码队列超过上限时会等出队，逐帧推演时不要并发调用。
 */
import type {
  ExportResult,
  Exporter,
  FrameCarrier,
  Ms,
} from "@lingfan-video/contracts";
import { EncoderGate } from "../encoder-gate";
import { WebmAudioTrack } from "./audio-track";
import { WebmMuxer } from "./webm-muxer";
import { WebmVideoTrack } from "./video-track";
import type { WebmExporterOptions } from "./types";

/** 关键帧间隔：给随机访问/拖动一个可用粒度 */
const KEYFRAME_INTERVAL = 60;

/**
 * VP8/VP9 + Opus 的 WebM 导出器：把推演出的每一帧与每块音频写进编码器，
 * `finalize` 时 flush 编码器再封装成 WebM。
 *
 * 用法上只有一条硬规则：**先写完所有帧与音频，再 `finalize`**，且 `finalize`
 * 之后不能再写（会抛 `SpecViolation`）。编码器实例都是惰性创建的：第一帧到来
 * 时才建视频编码器，透明档还要多建一个 alpha 平面编码器；第一块音频到来时才
 * 建音频编码器——所以纯视频导出不会多开音频编码器。
 *
 * 编码错误（平台编码器异步报错）由 `error` 回调记录，之后任何写入/收尾都按
 * 同一错误失败，不会静默继续。
 */
export class WebmExporter implements Exporter {
  /** 实现标识：契约里的 `webm` */
  readonly impl = "webm" as const;
  /** 产物格式：固定 webm */
  readonly format = "webm" as const;
  /**
   * 产物是否携带 alpha 通道。
   *
   * WebM 的 alpha 不是格式自带的：它是一条并行的侧通道，要在编码器（第二个
   * 编码器编 alpha 平面）与容器（`AlphaMode` + 块组附加数据）两侧一起声明。
   * 所以这个能力由构造参数决定，引擎在首帧前用它判断与透明度声明是否对得上。
   */
  readonly alpha: boolean;
  /** 容器写入器：编码块按到达顺序追加，`finalize` 时一次性封装 */
  private readonly muxer = new WebmMuxer();
  /** 编码错误与编码队列背压的共用通道 */
  private readonly gate = new EncoderGate();
  /** 视频轨：颜色编码与 alpha 侧通道 */
  private readonly video: WebmVideoTrack;
  /** 音频轨：Opus 编码与私有数据 */
  private readonly audio: WebmAudioTrack;
  /** 构造时给定的参数（尺寸/码率/帧率提示/是否透明） */
  private readonly opts: WebmExporterOptions;
  /** 上一帧的时间戳（微秒）；用于估算本帧时长，`null` 表示首帧 */
  private lastTimestampUs: number | null = null;
  /** 已写入的视频帧数 */
  private count = 0;
  /** 最后一帧的时间戳（毫秒），作为 `ExportResult.durationMs` */
  private durationMs: Ms = 0;
  /** 是否已 `finalize` 成功；置位后一切写入都抛错 */
  private finalized = false;
  /** `finalize` 是否正在执行：拒绝并发/重入，避免同一容器被封装两次 */
  private finalizing = false;

  /**
   * @param opts 输出尺寸、编解码器与码率等参数；`width`/`height` 必须与送入帧一致
   */
  constructor(opts: WebmExporterOptions) {
    this.opts = opts;
    this.alpha = opts.alpha === true;
    this.video = new WebmVideoTrack(
      opts,
      (chunk) => this.muxer.addVideo(chunk),
      this.gate,
    );
    this.audio = new WebmAudioTrack(
      (chunk) => this.muxer.addAudio(chunk),
      this.gate,
      opts.audioBitrate,
    );
  }

  /**
   * 写入一帧。
   *
   * 时间戳由调用方给定的时间线决定（不是按 `fps` 递增），帧时长用相邻帧
   * 时间戳之差估算，首帧取 `1000/fps` 毫秒。不透明档句柄与位图都收；透明档
   * 只收位图（要逐像素 alpha）。
   *
   * @param frame 帧载体：句柄（设备侧对象/画布）或位图
   * @param timestampMs 该帧在片中的时间戳（毫秒，从 0 起，单调不减）
   */
  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    this.assertOpen("writeFrame");
    this.gate.throwIfFailed();
    if (typeof VideoFrame === "undefined")
      throw new Error(
        "WebmExporter 需要 WebCodecs 环境（浏览器）；Node 请用 FrameSequenceExporter 或 ApngExporter",
      );
    /** 本帧时间戳（微秒）：时间线毫秒 ×1000，编码器只认整数微秒 */
    const timestampUs = Math.round(timestampMs * 1000);
    /** 本帧时长（微秒）：首帧按 fps 推，之后取与上一帧的差 */
    const durationUs =
      this.lastTimestampUs === null
        ? Math.round(1000000 / this.opts.fps)
        : timestampUs - this.lastTimestampUs;
    this.lastTimestampUs = timestampUs;
    this.durationMs = timestampMs;
    this.video.encode(
      frame,
      timestampUs,
      durationUs,
      this.count % KEYFRAME_INTERVAL === 0,
    );
    this.count++;
    await this.video.drain();
  }

  /**
   * 写入 PCM 块：samples 为交错 Float32（长度 = 帧数 × channels），
   * 块序列自 0 起连续，拼接即整轨（与 AudioSample 契约一致）。
   *
   * 采样率必须是 48kHz（Opus 的固定工作采样率），否则首块即抛
   * `SpecViolation`；布局（声道数）由首块定下，之后不一致同样报错。
   *
   * @param samples 交错 Float32 PCM；长度必须是 `channels` 的整数倍，元素取值 −1..1
   * @param sampleRate 采样率（赫兹）；WebM 音轨固定 48kHz
   * @param channels 声道数（1 = 单声道，2 = 立体声）
   */
  async writeAudio(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void> {
    this.assertOpen("writeAudio");
    this.gate.throwIfFailed();
    await this.audio.write(samples, sampleRate, channels);
  }

  /**
   * 收尾：flush 并关闭编码器，然后把容器封装成 WebM。
   *
   * 必须至少写入过一帧（否则抛错）。返回时所有编码块都已入容器，`output` 是
   * 完整的 webm 字节。成功后重复调用会抛 `SpecViolation`；封装阶段抛错时
   * `finalized` 不置位，可用同一实例重试（编码器已在首次收尾时关闭）。
   *
   * @returns 产物字节、帧数与时长（毫秒）；`durationMs` 是最后一帧的时间戳
   */
  async finalize(): Promise<ExportResult> {
    this.assertOpen("finalize");
    if (this.finalizing)
      throw Object.assign(
        new Error("WebmExporter.finalize：上一次 finalize 仍在执行"),
        { name: "SpecViolation" },
      );
    this.gate.throwIfFailed();
    if (this.count === 0)
      throw new Error("WebmExporter：无已编码帧（finalize 前需 writeFrame）");
    this.finalizing = true;
    try {
      await this.video.flushAndClose();
      await this.audio.flushAndClose();
      /** 完整 webm 字节（EBML 头 + 段一次拼好） */
      const bytes = this.muxer.finalize(
        {
          width: this.opts.width,
          height: this.opts.height,
          codec: this.opts.videoCodec === "vp8" ? "V_VP8" : "V_VP9",
          defaultDurationNs: Math.round(1e9 / this.opts.fps),
          alpha: this.opts.alpha === true,
        },
        this.audio.spec(),
        this.durationMs,
      );
      this.finalized = true;
      return {
        output: new Blob([bytes], { type: "video/webm" }),
        frames: this.count,
        durationMs: this.durationMs,
        format: "webm",
      };
    } finally {
      this.finalizing = false;
    }
  }

  /**
   * 写入前的前置检查：`finalize` 之后一切写入都是用法错误。
   *
   * @param op 出错的调用名（拼进错误信息，便于定位）
   */
  private assertOpen(op: string): void {
    if (this.finalized)
      throw Object.assign(
        new Error(`WebmExporter.${op}：finalize 之后不能再写入`),
        { name: "SpecViolation" },
      );
  }
}
