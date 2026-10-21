/**
 * WebCodecs 导出适配器（Exporter 的 'webcodecs' 实现）：
 * VideoEncoder 编 H.264、AudioEncoder 编 AAC-LC，Mp4Muxer 封装为 mp4。
 * 仅浏览器环境可用（WebCodecs 为平台 API）；Node 下组合根应选 frames。
 *
 * 写入顺序：所有帧与音频块都必须在 finalize 之前写完（封装需要完整的 moov）。
 *
 * 与另外两条导出路径的差别（能力与产物都不同）：
 * - 这条走设备侧硬编，产物是**单个 mp4 文件**，帧由平台编码器压缩，
 *   因此输出是「编码后再解码」的结果，不是像素级无损的帧序列；
 * - 帧序列导出（`frame-sequence-exporter`）留下的是逐帧原始位图，可无损再加工；
 * - mp4 封装层（`mp4/`）只负责容器，本文件是它的一个使用者。
 *
 * 同步性：`writeFrame` / `writeAudio` 都是异步的——编码队列超过上限时会等
 * 出队（背压），所以逐帧推演时不要并发调用它们。
 *
 * 结构：本文件只做「时序编排与收尾」；帧编码、音频编码与错误接力分别在同目录的
 * `video-track`、`audio-track`、`encoder-gate` 里，三块互不依赖对方的内部状态。
 */
import type {
  ExportResult,
  Exporter,
  FrameCarrier,
  Ms,
} from "@lingfan-video/contracts";
import { Mp4Muxer, makeAvcC } from "../mp4";
import { AudioTrack } from "./audio-track";
import { EncoderGate } from "../encoder-gate";
import { VideoTrack } from "./video-track";
import type { WebCodecsExporterOptions } from "./types";

/**
 * H.264 + AAC 的 mp4 导出器：把推演出的每一帧与每块音频写进编码器，
 * `finalize` 时 flush 两个编码器再封装成 mp4。
 *
 * 用法上只有一条硬规则：**先写完所有帧与音频，再 `finalize`**，且
 * `finalize` 之后不能再写（会抛 `SpecViolation`）。编码器实例是惰性创建的：
 * 第一帧到来时才建视频编码器，第一块音频到来时才建音频编码器——所以纯视频
 * 导出不会多开一个音频编码器。
 *
 * 编码错误（平台编码器异步报错）由 `error` 回调记录，之后任何写入/收尾都按
 * 同一错误失败，不会静默继续；`finalize` 里先 `flush` 让所有待编码块出队，
 * 因此返回时封装已完成、`output` 是可直接落盘的完整文件字节。
 */
export class WebCodecsExporter implements Exporter {
  /** 实现标识：契约里的 `webcodecs` */
  readonly impl = "webcodecs" as const;
  /** 产物格式：固定 mp4 */
  readonly format = "mp4" as const;
  /** 容器写入器：编码块按到达顺序追加，`finalize` 时一次性封装 */
  private readonly muxer = new Mp4Muxer();
  /** 编码错误与编码队列背压的共用通道 */
  private readonly gate = new EncoderGate();
  /** 视频轨：帧编码与 SPS/PPS 提取 */
  private readonly video: VideoTrack;
  /** 音频轨：音频编码与 AAC 配置提取 */
  private readonly audio: AudioTrack;
  /** 构造时给定的参数（尺寸/码率/帧率提示） */
  private readonly opts: WebCodecsExporterOptions;
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
   * @param opts 输出尺寸与码率等参数；`width`/`height` 必须与送入帧的尺寸一致
   */
  constructor(opts: WebCodecsExporterOptions) {
    this.opts = opts;
    this.video = new VideoTrack(opts, this.muxer, this.gate);
    this.audio = new AudioTrack(opts, this.muxer, this.gate);
  }

  /**
   * 写入一帧。
   *
   * 时间戳由调用方给定的时间线决定（不是按 `fps` 递增），帧时长用相邻帧
   * 时间戳之差估算，首帧取 `1000/fps` 毫秒。句柄帧直接交给编码器（设备侧
   * 对象，不读像素）；位图帧需要拷一次到 `VideoFrame`（它本来就是 CPU 像素）。
   * 每写入一帧都可能因编码队列过深而等待出队。
   *
   * @param frame 帧载体：句柄（设备侧对象/画布）或位图
   * @param timestampMs 该帧在片中的时间戳（毫秒，从 0 起，单调不减）
   */
  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    this.assertOpen("writeFrame");
    this.gate.throwIfFailed();
    if (typeof VideoFrame === "undefined")
      throw new Error(
        "WebCodecsExporter 需要 WebCodecs 环境（浏览器）；Node 请用 FrameSequenceExporter",
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
    // 每 60 帧一个关键帧：给随机访问/拖动一个可用粒度
    this.video.encode(frame, timestampUs, durationUs, this.count % 60 === 0);
    this.count++;
    await this.video.drain();
  }

  /**
   * 写入 PPM 块：samples 为交错 Float32（长度 = 帧数 × channels），
   * 块序列自 0 起连续，拼接即整轨（与 AudioSample 契约一致）。
   *
   * 内部按每块最多 4096 个采样帧切分后逐块提交（限制单次 `AudioData` 大小），
   * 每块都转成平面布局（`f32-planar`）并等待编码队列出队，因此一次调用
   * 期间可能长时间 await。布局（采样率/声道数）由首块定下，之后不一致即抛
   * `SpecViolation`——同一条音轨不能中途换布局；样本数不整除声道的块在
   * 定布局之前就被拒，不会占掉一条坏布局。
   *
   * @param samples 交错 Float32 PCM；长度必须是 `channels` 的整数倍，元素取值 −1..1
   * @param sampleRate 采样率（赫兹）
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
   * 收尾：flush 并关闭两个编码器，然后把容器封装成 mp4。
   *
   * 必须至少写入过一帧（否则抛错）；还必须拿到 AVC 参数集（SPS/PPS），
   * 它们来自编码器的 `decoderConfig`，拿不到就无法写 `avcC`。
   * 返回时所有编码块都已入容器，`output` 是完整的 mp4 字节。
   * 成功后重复调用会抛 `SpecViolation`；封装阶段抛错时 `finalized` 不置位，
   * 可用同一实例重试（编码器已在首次收尾时关闭，重试只重新封装）。
   *
   * @returns 产物字节、帧数与时长（毫秒）；`durationMs` 是最后一帧的时间戳
   */
  async finalize(): Promise<ExportResult> {
    this.assertOpen("finalize");
    if (this.finalizing)
      throw Object.assign(
        new Error("WebCodecsExporter.finalize：上一次 finalize 仍在执行"),
        { name: "SpecViolation" },
      );
    this.gate.throwIfFailed();
    if (this.count === 0)
      throw new Error(
        "WebCodecsExporter：无已编码帧（finalize 前需 writeFrame）",
      );
    /** 封装需要的 AVC 参数集（首个编码块才带来） */
    const sps = this.video.sps;
    const pps = this.video.pps;
    if (!sps || !pps)
      throw new Error(
        "WebCodecsExporter：缺少 AVC 参数集（编码器未输出 decoderConfig）",
      );
    this.finalizing = true;
    try {
      // 首次收尾才需要 flush 并关闭编码器；封装失败后的重试它们已经是 null
      await this.video.flushAndClose();
      await this.audio.flushAndClose();
      /** 完整 mp4 字节（ftyp + moov + mdat 一次拼好） */
      const output = this.muxer.finalize(
        {
          width: this.opts.width,
          height: this.opts.height,
          avcC: makeAvcC(sps, pps),
        },
        this.audio.spec(),
      );
      this.finalized = true;
      return {
        output,
        frames: this.count,
        durationMs: this.durationMs,
        format: "mp4",
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
        new Error(`WebCodecsExporter.${op}：finalize 之后不能再写入`),
        { name: "SpecViolation" },
      );
  }
}
