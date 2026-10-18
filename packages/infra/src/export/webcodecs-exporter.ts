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
 */
import type {
  ExportResult,
  Exporter,
  FrameBitmap,
  FrameCarrier,
  FrameHandle,
  Ms,
} from "@lingfan-video/contracts";
import { Mp4Muxer, extractParameterSets, makeAacConfig, makeAvcC } from "./mp4";

/** WebCodecs 导出参数 */
export interface WebCodecsExporterOptions {
  /** 输出宽（像素）；也是编码器 `codedWidth`，位图帧的尺寸必须与之一致 */
  width: number;
  /** 输出高（像素）；也是编码器 `codedHeight`，位图帧的尺寸必须与之一致 */
  height: number;
  /** 视频帧率声明（仅用于编码器提示；实际时间戳来自帧） */
  fps: number;
  /** 视频码率（bps），缺省 8Mbps */
  bitrate?: number;
  /** 音频码率（bps），缺省 128kbps */
  audioBitrate?: number;
}

/** 音频编码一次提交的最大帧数（限制单次 AudioData 大小） */
const AUDIO_BLOCK_FRAMES = 4096;
/** 编码队列上限（超过则等待出队，避免长音频堆积内存） */
const MAX_ENCODE_QUEUE = 16;

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
  /** 构造时给定的参数（尺寸/码率/帧率提示） */
  private readonly opts: WebCodecsExporterOptions;
  /** 视频编码器：首帧时创建，`finalize` 时关闭 */
  private videoEncoder: VideoEncoder | null = null;
  /** 音频编码器：首块音频时创建；没有音频时恒为 `null` */
  private audioEncoder: AudioEncoder | null = null;
  /** H.264 SPS（从编码器 `decoderConfig.description` 提取）；缺则无法封装 */
  private sps: Uint8Array | null = null;
  /** H.264 PPS，与 `sps` 同时取得 */
  private pps: Uint8Array | null = null;
  /** AAC AudioSpecificConfig（从音频编码器描述提取；缺省时按采样率推） */
  private asc: Uint8Array | null = null;
  /** 音频轨布局：首块音频定下，后续块必须一致 */
  private audioLayout: { sampleRate: number; channels: number } | null = null;
  /** 已提交的音频帧数（用于给后续 AudioData 推算时间戳，单位：采样帧） */
  private audioFrames = 0;
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
  /** 首个异步编码错误：编码器的 `error` 回调不在写调用链上，必须自己接住再回放 */
  private failure: Error | null = null;
  /** 正在等待编码队列出队的调用方（错误到来时统一唤醒，避免永远卡住） */
  private drainWaiters: (() => void)[] = [];

  /**
   * @param opts 输出尺寸与码率等参数；`width`/`height` 必须与送入帧的尺寸一致
   */
  constructor(opts: WebCodecsExporterOptions) {
    this.opts = opts;
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
    this.throwIfFailed();
    if (typeof VideoFrame === "undefined")
      throw new Error(
        "WebCodecsExporter 需要 WebCodecs 环境（浏览器）；Node 请用 FrameSequenceExporter",
      );
    this.ensureVideoEncoder();
    /** 本帧时间戳（微秒）：时间线毫秒 ×1000，编码器只认整数微秒 */
    const timestampUs = Math.round(timestampMs * 1000);
    /** 本帧时长（微秒）：首帧按 fps 推，之后取与上一帧的差 */
    const durationUs =
      this.lastTimestampUs === null
        ? Math.round(1000000 / this.opts.fps)
        : timestampUs - this.lastTimestampUs;
    this.lastTimestampUs = timestampUs;
    this.durationMs = timestampMs;

    // 句柄帧走设备侧：不读像素、不上传，直接交给编码器（时间戳仍由时间线决定，
    // 所以这里用时间线的值重建一个引用，保证同一剧本得到同一串时间戳）。
    /** 交给编码器的一帧：时间戳/时长按时间线重建，内容借用原载体 */
    const videoFrame = this.frameToVideoFrame(frame, timestampUs, durationUs);
    try {
      this.videoEncoder!.encode(videoFrame, {
        // 每 60 帧一个关键帧：给随机访问/拖动一个可用粒度
        keyFrame: this.count % 60 === 0,
      });
    } finally {
      videoFrame.close();
    }
    this.count++;
    await this.drain(this.videoEncoder!);
  }

  /** 载体 → VideoFrame：位图必须拷贝一次（它本来就是 CPU 像素），句柄则借用设备侧对象 */
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
    this.throwIfFailed();
    if (typeof AudioEncoder === "undefined")
      throw new Error(
        "WebCodecsExporter.writeAudio 需要 WebCodecs 环境（浏览器）；Node 无音频编码",
      );
    // 先校验样本数：布局一旦被首块定下就不可更改，坏块不能占掉布局
    if (samples.length % channels !== 0)
      throw Object.assign(
        new Error(
          `writeAudio 布局不符：样本数 ${samples.length} 不是声道数 ${channels} 的整数倍`,
        ),
        { name: "SpecViolation" },
      );
    this.ensureAudioEncoder(sampleRate, channels);
    /** 采样帧数（每帧含 `channels` 个样本） */
    const totalFrames = samples.length / channels;
    for (let off = 0; off < totalFrames; off += AUDIO_BLOCK_FRAMES) {
      /** 本块采样帧数：正常取满上限，尾块取余数 */
      const frames = Math.min(AUDIO_BLOCK_FRAMES, totalFrames - off);
      /** 本块的平面布局样本（各声道首尾相接） */
      const planar = toPlanar(samples, channels, off, frames);
      /** 提交给编码器的一块音频；时间戳按已提交的采样帧数推算（微秒） */
      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((this.audioFrames / sampleRate) * 1e6),
        data: planar.buffer as ArrayBuffer,
      });
      this.audioEncoder!.encode(data);
      data.close();
      this.audioFrames += frames;
      await this.drain(this.audioEncoder!);
    }
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
    this.throwIfFailed();
    if (this.count === 0)
      throw new Error(
        "WebCodecsExporter：无已编码帧（finalize 前需 writeFrame）",
      );
    if (!this.sps || !this.pps)
      throw new Error(
        "WebCodecsExporter：缺少 AVC 参数集（编码器未输出 decoderConfig）",
      );
    this.finalizing = true;
    try {
      // 首次收尾才需要 flush 并关闭编码器；封装失败后的重试它们已经是 null
      if (this.videoEncoder) {
        await this.videoEncoder.flush();
        this.throwIfFailed();
        this.videoEncoder.close();
        this.videoEncoder = null;
      }
      if (this.audioEncoder) {
        await this.audioEncoder.flush();
        this.throwIfFailed();
        this.audioEncoder.close();
        this.audioEncoder = null;
      }
      /** 音频轨规格；没有写过音频则为 `undefined`（产物只有视频轨） */
      const audio = this.audioLayout
        ? this.audioTrackSpec(
            this.audioLayout.sampleRate,
            this.audioLayout.channels,
          )
        : undefined;
      /** 完整 mp4 字节（ftyp + moov + mdat 一次拼好） */
      const output = this.muxer.finalize(
        {
          width: this.opts.width,
          height: this.opts.height,
          avcC: makeAvcC(this.sps, this.pps),
        },
        audio,
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
   * 组装容器需要的音频轨规格。
   *
   * @param sampleRate 采样率（赫兹）
   * @param channels 声道数
   * @returns 容器用的音频轨描述；采样率不在 AAC 常见档位内时抛 `SpecViolation`
   */
  private audioTrackSpec(
    sampleRate: number,
    channels: number,
  ): {
    sampleRate: number;
    channels: number;
    asc: Uint8Array;
    bitrate: number;
  } {
    /** AAC 配置字节：编码器给了就用它的，否则按采样率/声道推 */
    const asc = this.asc ?? makeAacConfig(sampleRate, channels);
    if (!asc)
      throw Object.assign(
        new Error(
          `音频轨：采样率 ${sampleRate} 不支持 AAC 编码（需 8k–96k 常见档位）`,
        ),
        { name: "SpecViolation" },
      );
    return {
      sampleRate,
      channels,
      asc,
      bitrate: this.opts.audioBitrate ?? 128_000,
    };
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

  /**
   * 记录首个异步编码错误并唤醒所有等待出队的调用方。
   *
   * 编码器的 `error` 回调运行在写调用链之外：在那里 `throw` 只会变成未捕获异常，
   * 调用方拿不到失败信号。这里把错误存下来，后续 `writeFrame` / `writeAudio` /
   * `finalize` 以及正在等待出队的调用统一按它失败。
   *
   * @param error 编码器报告的失败
   */
  private fail(error: Error): void {
    if (this.failure === null) this.failure = error;
    this.wakeDrainWaiters();
  }

  /** 已记录编码错误时抛出：同一错误一直沿用到实例被丢弃，写入不会静默继续 */
  private throwIfFailed(): void {
    if (this.failure !== null) throw this.failure;
  }

  /** 唤醒所有正在等待编码队列出队的调用方（正常出队与错误共用这条唤醒） */
  private wakeDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** 惰性创建并配置视频编码器（H.264 baseline，`avc` 格式输出长度前缀参数集） */
  private ensureVideoEncoder(): void {
    if (this.videoEncoder) return;
    /** 视频编码器：输出回调把编码块追加进容器，并从首个块的描述里取 SPS/PPS */
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        /** 编码器给的解码器配置描述；首个块才带 SPS/PPS */
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.sps) {
          /** 从解码器描述里拆出的参数集 */
          const ps = extractParameterSets(desc as ArrayBuffer);
          this.sps = ps.sps;
          this.pps = ps.pps;
        }
        this.muxer.addVideo({
          data: copyBytes(chunk),
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 0,
          keyFrame: chunk.type === "key",
        });
      },
      error: (e) => this.fail(new Error(`VideoEncoder 错误：${e.message}`)),
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
    this.videoEncoder = encoder;
  }

  /** 音频编码器按第一块的布局装配；后续块布局必须一致（同一条轨） */
  private ensureAudioEncoder(sampleRate: number, channels: number): void {
    /** 已定下的音频布局；`null` 表示还没写过音频 */
    const layout = this.audioLayout;
    if (
      layout &&
      (layout.sampleRate !== sampleRate || layout.channels !== channels)
    )
      throw Object.assign(
        new Error(
          `writeAudio 布局已定为 ${layout.sampleRate}Hz/${layout.channels}ch，` +
            `后续块为 ${sampleRate}Hz/${channels}ch（同一条音轨布局必须一致）`,
        ),
        { name: "SpecViolation" },
      );
    if (this.audioEncoder) return;
    /** 音频编码器：输出回调把 AAC 块追加进容器，并从描述里取 AudioSpecificConfig */
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        /** 音频解码器配置描述：首个块才带 AudioSpecificConfig */
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.asc) this.asc = new Uint8Array(desc as ArrayBuffer);
        this.muxer.addAudio({
          data: copyBytes(chunk),
          durationUs: chunk.duration ?? 0,
        });
      },
      error: (e) => this.fail(new Error(`AudioEncoder 错误：${e.message}`)),
    });
    encoder.configure({
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate: this.opts.audioBitrate ?? 128_000,
    });
    this.audioEncoder = encoder;
    this.audioLayout = { sampleRate, channels };
  }

  /** 编码队列过深时等待出队（长音频不能无限堆积；编码错误同样走这条唤醒） */
  private async drain(encoder: VideoEncoder | AudioEncoder): Promise<void> {
    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      this.throwIfFailed();
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
        encoder.ondequeue = () => this.wakeDrainWaiters();
      });
    }
    this.throwIfFailed();
  }
}

/** EncodedChunk 数据拷贝（chunk 的 buffer 由编码器复用） */
function copyBytes(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  /** 拷贝目标：编码器的缓冲会被复用，必须自己留一份 */
  const out = new Uint8Array(new ArrayBuffer(chunk.byteLength));
  chunk.copyTo(out.buffer);
  return out;
}

/** 交错 Float32 → 平面 Float32（AudioData 的 f32-planar 布局） */
function toPlanar(
  interleaved: Float32Array,
  channels: number,
  offsetFrames: number,
  frames: number,
): Float32Array {
  /** 平面布局结果：各声道依次放满 `frames` 个样本 */
  const out = new Float32Array(frames * channels);
  for (let ch = 0; ch < channels; ch++) {
    /** 本声道在输出里的起始下标 */
    const base = ch * frames;
    for (let f = 0; f < frames; f++) {
      out[base + f] = interleaved[(offsetFrames + f) * channels + ch] ?? 0;
    }
  }
  return out;
}
