/**
 * 音频轨：AAC-LC 编码器的生命周期、布局校验与交错 PCM 的分块提交。
 *
 * 布局（采样率/声道数）由首块定下，之后不一致即抛 `SpecViolation`——同一条音轨
 * 不能中途换布局。编码器惰性创建：没有音频的导出不会多开一个编码器。
 */
import { makeAacConfig } from "../mp4";
import type { Mp4Muxer } from "../mp4";
import type { EncoderGate } from "./encoder-gate";
import { AUDIO_BLOCK_FRAMES } from "./types";
import type { WebCodecsExporterOptions } from "./types";

/** 音频轨：首块定布局、逐块编码，收尾时 flush/close 并交出封装需要的轨规格 */
export class AudioTrack {
  /** 编码器：首块音频时创建；没有音频时恒为 `null` */
  private encoder: AudioEncoder | null = null;
  /** AAC AudioSpecificConfig（从音频编码器描述提取；缺省时按采样率推） */
  private ascBytes: Uint8Array | null = null;
  /** 音频轨布局：首块音频定下，后续块必须一致 */
  private audioLayout: { sampleRate: number; channels: number } | null = null;
  /** 已提交的音频帧数（用于给后续 AudioData 推算时间戳，单位：采样帧） */
  private audioFrames = 0;

  /**
   * @param opts 导出参数（音频码率）
   * @param muxer 容器写入器：编码块按到达顺序追加
   * @param gate 编码错误与背压的共用通道
   */
  constructor(
    private readonly opts: WebCodecsExporterOptions,
    private readonly muxer: Mp4Muxer,
    private readonly gate: EncoderGate,
  ) {}

  /** 已定下的音频布局；`null` 表示还没写过音频 */
  get layout(): { sampleRate: number; channels: number } | null {
    return this.audioLayout;
  }

  /**
   * 写入一块交错 PCM：按每块最多 `AUDIO_BLOCK_FRAMES` 个采样帧切分后逐块提交。
   *
   * 每块都转成平面布局（`f32-planar`）并等待编码队列出队，因此一次调用
   * 期间可能长时间 await。样本数不整除声道的块在定布局之前就被拒，
   * 不会占掉一条坏布局。
   *
   * @param samples 交错 Float32 PCM；长度必须是 `channels` 的整数倍，元素取值 −1..1
   * @param sampleRate 采样率（赫兹）
   * @param channels 声道数（1 = 单声道，2 = 立体声）
   */
  async write(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void> {
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
    this.ensureEncoder(sampleRate, channels);
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
      this.encoder!.encode(data);
      data.close();
      this.audioFrames += frames;
      await this.gate.drain(this.encoder!);
    }
  }

  /**
   * 组装容器需要的音频轨规格；没有写过音频时返回 `undefined`（产物只有视频轨）。
   *
   * @returns 采样率、声道数、AAC 配置与码率；采样率不在 AAC 常见档位内时抛 `SpecViolation`
   */
  spec():
    | { sampleRate: number; channels: number; asc: Uint8Array; bitrate: number }
    | undefined {
    const layout = this.audioLayout;
    if (!layout) return undefined;
    /** AAC 配置字节：编码器给了就用它的，否则按采样率/声道推 */
    const asc =
      this.ascBytes ?? makeAacConfig(layout.sampleRate, layout.channels);
    if (!asc)
      throw Object.assign(
        new Error(
          `音频轨：采样率 ${layout.sampleRate} 不支持 AAC 编码（需 8k–96k 常见档位）`,
        ),
        { name: "SpecViolation" },
      );
    return {
      sampleRate: layout.sampleRate,
      channels: layout.channels,
      asc,
      bitrate: this.opts.audioBitrate ?? 128_000,
    };
  }

  /** flush 并关闭编码器（只在存在时操作；收尾失败后可重试） */
  async flushAndClose(): Promise<void> {
    if (!this.encoder) return;
    await this.encoder.flush();
    this.gate.throwIfFailed();
    this.encoder.close();
    this.encoder = null;
  }

  /** 音频编码器按第一块的布局装配；后续块布局必须一致（同一条轨） */
  private ensureEncoder(sampleRate: number, channels: number): void {
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
    if (this.encoder) return;
    /** 音频编码器：输出回调把 AAC 块追加进容器，并从描述里取 AudioSpecificConfig */
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        /** 音频解码器配置描述：首个块才带 AudioSpecificConfig */
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.ascBytes)
          this.ascBytes = new Uint8Array(desc as ArrayBuffer);
        this.muxer.addAudio({
          data: copyBytes(chunk),
          durationUs: chunk.duration ?? 0,
        });
      },
      error: (e) =>
        this.gate.fail(new Error(`AudioEncoder 错误：${e.message}`)),
    });
    encoder.configure({
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate: this.opts.audioBitrate ?? 128_000,
    });
    this.encoder = encoder;
    this.audioLayout = { sampleRate, channels };
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
