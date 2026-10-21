/**
 * WebM 音频轨：Opus 编码器的生命周期、布局校验与交错 PCM 的分块提交。
 *
 * Opus 把自己的采样信息放在一段叫 `OpusHead` 的私有数据里（19 字节固定头 +
 * 可选的声道映射表），容器轨的 `CodecPrivate` 就写它——缺了它播放器不知道
 * 声道布局。布局（采样率/声道）由首块定下，之后不一致即抛 `SpecViolation`。
 *
 * 编码器惰性创建：没有音频的导出不会多开一个编码器。
 */
import type { EncoderGate } from "../encoder-gate";
import { AUDIO_BLOCK_FRAMES } from "../encode-limits";
import { toPlanarFloat32 } from "../audio-planar";
import { copyChunkBytes } from "../encoded-chunk";
import type { WebmAudioSpec } from "./types";

/** Opus 的采样率固定 48kHz（容器侧允许别的值，但编码器只按这个工作） */
const OPUS_SAMPLE_RATE = 48_000;
/** Opus 私有数据长度：固定 19 字节（不含可选的声道映射表） */
const OPUS_HEAD_BYTES = 19;
/** OpusHead 的版本号（当前规范只有 1） */
const OPUS_HEAD_VERSION = 1;
/** Opus 输出增益（Q7.8 定点，0 表示不增减） */
const OPUS_OUTPUT_GAIN = 0;
/** Opus 声道映射族：0 = 单流单声道/立体声（无需映射表） */
const OPUS_MAPPING_FAMILY = 0;

/** 音频轨：首块定布局、逐块编码，收尾时 flush/close 并交出封装需要的轨规格 */
export class WebmAudioTrack {
  /** 编码器：首块音频时创建；没有音频时恒为 `null` */
  private encoder: AudioEncoder | null = null;
  /** 音频轨布局：首块音频定下，后续块必须一致 */
  private layout: { sampleRate: number; channels: number } | null = null;
  /** 已提交的采样帧数（用于给后续 AudioData 推算时间戳） */
  private frames = 0;

  /**
   * @param onChunk 编码块的落点（容器）
   * @param gate 编码错误与背压的共用通道
   * @param bitrate 音频码率（bps），缺省 128kbps
   */
  constructor(
    private readonly onChunk: (chunk: {
      data: Uint8Array;
      timestampUs: number;
      durationUs: number;
    }) => void,
    private readonly gate: EncoderGate,
    private readonly bitrate = 128_000,
  ) {}

  /** 已定下的音频布局；`null` 表示还没写过音频 */
  get audioLayout(): { sampleRate: number; channels: number } | null {
    return this.layout;
  }

  /**
   * 写入一块交错 PCM：按每块最多 `AUDIO_BLOCK_FRAMES` 个采样帧切分后逐块提交。
   *
   * 样本数不整除声道的块在定布局之前就被拒，不会占掉一条坏布局。
   *
   * @param samples 交错 Float32 PCM；长度必须是 `channels` 的整数倍，元素取值 −1..1
   * @param sampleRate 采样率（赫兹）；必须是 48kHz（Opus 只按它工作）
   * @param channels 声道数（1 = 单声道，2 = 立体声）
   */
  async write(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void> {
    if (typeof AudioEncoder === "undefined")
      throw new Error(
        "WebmExporter.writeAudio 需要 WebCodecs 环境（浏览器）；Node 无音频编码",
      );
    if (sampleRate !== OPUS_SAMPLE_RATE)
      throw Object.assign(
        new Error(
          `WebM 音频轨用 Opus 编码，采样率固定 ${OPUS_SAMPLE_RATE}Hz：收到 ${sampleRate}Hz`,
        ),
        { name: "SpecViolation" },
      );
    // 先校验样本数：布局一旦被首块定下就不可更改，坏块不能占掉布局
    if (samples.length % channels !== 0)
      throw Object.assign(
        new Error(
          `writeAudio 布局不符：样本数 ${samples.length} 不是声道数 ${channels} 的整数倍`,
        ),
        { name: "SpecViolation" },
      );
    this.ensureEncoder(channels);
    /** 采样帧数（每帧含 `channels` 个样本） */
    const totalFrames = samples.length / channels;
    for (let off = 0; off < totalFrames; off += AUDIO_BLOCK_FRAMES) {
      /** 本块采样帧数：正常取满上限，尾块取余数 */
      const frames = Math.min(AUDIO_BLOCK_FRAMES, totalFrames - off);
      /** 本块的平面布局样本（各声道首尾相接） */
      const planar = toPlanarFloat32(samples, channels, off, frames);
      /** 提交给编码器的一块音频；时间戳按已提交的采样帧数推算（微秒） */
      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((this.frames / sampleRate) * 1e6),
        data: planar.buffer as ArrayBuffer,
      });
      this.encoder!.encode(data);
      data.close();
      this.frames += frames;
      await this.gate.drain(this.encoder!);
    }
  }

  /**
   * 组装容器需要的音频轨规格；没有写过音频时返回 `undefined`（产物只有视频轨）。
   *
   * @returns 采样率、声道数与 OpusHead 私有数据
   */
  spec(): WebmAudioSpec | undefined {
    const layout = this.layout;
    if (!layout) return undefined;
    return {
      sampleRate: OPUS_SAMPLE_RATE,
      channels: layout.channels,
      codecPrivate: opusHead(layout.channels),
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
  private ensureEncoder(channels: number): void {
    /** 已定下的音频布局；`null` 表示还没写过音频 */
    const layout = this.layout;
    if (layout && layout.channels !== channels)
      throw Object.assign(
        new Error(
          `writeAudio 布局已定为 ${layout.channels}ch，后续块为 ${channels}ch` +
            "（同一条音轨布局必须一致）",
        ),
        { name: "SpecViolation" },
      );
    if (this.encoder) return;
    /** 音频编码器：输出回调把 Opus 块交给容器 */
    const encoder = new AudioEncoder({
      output: (chunk) =>
        this.onChunk({
          data: copyChunkBytes(chunk),
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 0,
        }),
      error: (e) =>
        this.gate.fail(new Error(`AudioEncoder 错误：${e.message}`)),
    });
    encoder.configure({
      codec: "opus",
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: channels,
      bitrate: this.bitrate,
    });
    this.encoder = encoder;
    this.layout = { sampleRate: OPUS_SAMPLE_RATE, channels };
  }
}

/**
 * 组 19 字节的 `OpusHead`（RFC 7845 定义的 Opus 标识头）。
 *
 * 字段顺序：魔数 "OpusHead"、版本、声道数、预跳过采样数、输入采样率、输出增益、
 * 声道映射族。后两项在本仓只需要单流单声道/立体声，映射表留空。
 *
 * @param channels 声道数
 * @returns 私有数据字节
 */
export function opusHead(channels: number): Uint8Array {
  /** 私有数据缓冲：19 字节固定头 */
  const out = new Uint8Array(OPUS_HEAD_BYTES);
  /** 小端写入器（OpusHead 全用小端，与 EBML 的大端相反） */
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("OpusHead"), 0);
  out[8] = OPUS_HEAD_VERSION;
  out[9] = channels;
  view.setUint16(10, 3840, true);
  view.setUint32(12, OPUS_SAMPLE_RATE, true);
  view.setInt16(16, OPUS_OUTPUT_GAIN, true);
  out[18] = OPUS_MAPPING_FAMILY;
  return out;
}
