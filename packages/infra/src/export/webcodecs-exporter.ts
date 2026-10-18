/**
 * WebCodecs 导出适配器（Exporter 的 'webcodecs' 实现）：
 * VideoEncoder 编 H.264、AudioEncoder 编 AAC-LC，Mp4Muxer 封装为 mp4。
 * 仅浏览器环境可用（WebCodecs 为平台 API）；Node 下组合根应选 frames。
 *
 * 写入顺序：所有帧与音频块都必须在 finalize 之前写完（封装需要完整的 moov）。
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

export interface WebCodecsExporterOptions {
  width: number;
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

export class WebCodecsExporter implements Exporter {
  readonly impl = "webcodecs" as const;
  readonly format = "mp4" as const;
  private readonly muxer = new Mp4Muxer();
  private readonly opts: WebCodecsExporterOptions;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private asc: Uint8Array | null = null;
  private audioLayout: { sampleRate: number; channels: number } | null = null;
  private audioFrames = 0;
  private lastTimestampUs: number | null = null;
  private count = 0;
  private durationMs: Ms = 0;
  private finalized = false;

  constructor(opts: WebCodecsExporterOptions) {
    this.opts = opts;
  }

  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    this.assertOpen("writeFrame");
    if (typeof VideoFrame === "undefined")
      throw new Error(
        "WebCodecsExporter 需要 WebCodecs 环境（浏览器）；Node 请用 FrameSequenceExporter",
      );
    this.ensureVideoEncoder();
    const timestampUs = Math.round(timestampMs * 1000);
    const durationUs =
      this.lastTimestampUs === null
        ? Math.round(1000000 / this.opts.fps)
        : timestampUs - this.lastTimestampUs;
    this.lastTimestampUs = timestampUs;
    this.durationMs = timestampMs;

    // 句柄帧走设备侧：不读像素、不上传，直接交给编码器（时间戳仍由时间线决定，
    // 所以这里用时间线的值重建一个引用，保证同一剧本得到同一串时间戳）。
    const videoFrame = this.frameToVideoFrame(frame, timestampUs, durationUs);
    try {
      this.videoEncoder!.encode(videoFrame, {
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
    const bitmap: FrameBitmap = frame;
    return new VideoFrame(bitmap.data.buffer, {
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
   */
  async writeAudio(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void> {
    this.assertOpen("writeAudio");
    if (typeof AudioEncoder === "undefined")
      throw new Error(
        "WebCodecsExporter.writeAudio 需要 WebCodecs 环境（浏览器）；Node 无音频编码",
      );
    this.ensureAudioEncoder(sampleRate, channels);
    if (samples.length % channels !== 0)
      throw Object.assign(
        new Error(
          `writeAudio 布局不符：样本数 ${samples.length} 不是声道数 ${channels} 的整数倍`,
        ),
        { name: "SpecViolation" },
      );
    const totalFrames = samples.length / channels;
    for (let off = 0; off < totalFrames; off += AUDIO_BLOCK_FRAMES) {
      const frames = Math.min(AUDIO_BLOCK_FRAMES, totalFrames - off);
      const planar = toPlanar(samples, channels, off, frames);
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

  async finalize(): Promise<ExportResult> {
    this.assertOpen("finalize");
    if (!this.videoEncoder)
      throw new Error(
        "WebCodecsExporter：无已编码帧（finalize 前需 writeFrame）",
      );
    if (!this.sps || !this.pps)
      throw new Error(
        "WebCodecsExporter：缺少 AVC 参数集（编码器未输出 decoderConfig）",
      );
    await this.videoEncoder.flush();
    this.videoEncoder.close();
    this.videoEncoder = null;

    if (this.audioEncoder) await this.audioEncoder.flush();
    if (this.audioEncoder) this.audioEncoder.close();
    this.audioEncoder = null;

    const audio = this.audioLayout
      ? this.audioTrackSpec(
          this.audioLayout.sampleRate,
          this.audioLayout.channels,
        )
      : undefined;
    this.finalized = true;
    const output = this.muxer.finalize(
      {
        width: this.opts.width,
        height: this.opts.height,
        avcC: makeAvcC(this.sps, this.pps),
      },
      audio,
    );
    return {
      output,
      frames: this.count,
      durationMs: this.durationMs,
      format: "mp4",
    };
  }

  private audioTrackSpec(
    sampleRate: number,
    channels: number,
  ): {
    sampleRate: number;
    channels: number;
    asc: Uint8Array;
    bitrate: number;
  } {
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

  private assertOpen(op: string): void {
    if (this.finalized)
      throw Object.assign(
        new Error(`WebCodecsExporter.${op}：finalize 之后不能再写入`),
        { name: "SpecViolation" },
      );
  }

  private ensureVideoEncoder(): void {
    if (this.videoEncoder) return;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.sps) {
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
      error: (e) => {
        throw new Error(`VideoEncoder 错误：${e.message}`);
      },
    });
    encoder.configure({
      codec: "avc1.42001f",
      width: this.opts.width,
      height: this.opts.height,
      bitrate: this.opts.bitrate ?? 8_000_000,
      framerate: this.opts.fps,
      avc: { format: "avc" },
    });
    this.videoEncoder = encoder;
  }

  /** 音频编码器按第一块的布局装配；后续块布局必须一致（同一条轨） */
  private ensureAudioEncoder(sampleRate: number, channels: number): void {
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
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.asc) this.asc = new Uint8Array(desc as ArrayBuffer);
        this.muxer.addAudio({
          data: copyBytes(chunk),
          durationUs: chunk.duration ?? 0,
        });
      },
      error: (e) => {
        throw new Error(`AudioEncoder 错误：${e.message}`);
      },
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

  /** 编码队列过深时等待出队（长音频不能无限堆积） */
  private async drain(encoder: VideoEncoder | AudioEncoder): Promise<void> {
    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      await new Promise<void>((resolve) => {
        encoder.ondequeue = () => resolve();
      });
    }
  }
}

/** EncodedChunk 数据拷贝（chunk 的 buffer 由编码器复用） */
function copyBytes(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
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
  const out = new Float32Array(frames * channels);
  for (let ch = 0; ch < channels; ch++) {
    const base = ch * frames;
    for (let f = 0; f < frames; f++) {
      out[base + f] = interleaved[(offsetFrames + f) * channels + ch] ?? 0;
    }
  }
  return out;
}
