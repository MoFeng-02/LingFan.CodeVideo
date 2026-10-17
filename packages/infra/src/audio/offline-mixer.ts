/**
 * 离线确定性混音器（AudioClock 契约的导出端实现）：
 * 样本 = 时间线纯函数——同事件表必同输出（逐样本相同）。
 * 输入 = 引擎收集的音频事件 + 解码器；输出 = 交错 Float32 PCM。
 * 预览端实时实现（WebAudio）由宿主另行装配，不走本文件。
 */
import type {
  AudioClock,
  AudioClipRef,
  AudioSample,
  AudioTimelineEvent,
  DecodedAudio,
  Ms,
} from "@lingfan-video/contracts";
import { resolveWarp, sourceMsAt, timelineMsAtSource } from "./warp";

/** 离线解码器：把 clip url 变成交错 Float32 PCM（平台适配器注入；Node 测试用合成器替代） */
export interface AudioDecoder {
  decode(clip: AudioClipRef): Promise<DecodedPcm>;
}

/** 解码产物：交错 Float32 PCM（声道数与时长由实现持有） */
export interface DecodedPcm extends DecodedAudio {
  /** 交错样本：长度 = frames × channels */
  data: Float32Array;
}

export interface OfflineAudioMixerOptions {
  /** 输出采样率（导出目标；缺省 48000） */
  sampleRate?: number;
  /** 输出声道数（导出布局；缺省 2） */
  channels?: number;
}

const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_CHANNELS = 2;

/** OfflineAudioMixer：AudioClock 契约的导出端实现（样本=时间线纯函数） */
export class OfflineAudioMixer implements AudioClock {
  readonly sampleRate: number;
  readonly channels: number;

  constructor(
    private readonly decoder: AudioDecoder,
    options?: OfflineAudioMixerOptions,
  ) {
    this.sampleRate = options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.channels = options?.channels ?? DEFAULT_CHANNELS;
  }

  /** 混音全时间线：事件按 globalAtMs 铺入输出缓冲（多实例叠加、loop 平铺、fade 逐样本包络） */
  async renderTimeline(
    durationMs: Ms,
    events: readonly AudioTimelineEvent[],
  ): Promise<AudioSample[]> {
    const frames = Math.max(
      1,
      Math.ceil((durationMs / 1000) * this.sampleRate),
    );
    const out = new Float32Array(frames * this.channels);
    for (const ev of events) {
      const pcm = await this.decoder.decode({ url: ev.clipUrl, kind: "audio" });
      this.layoutEvent(ev, pcm, out, frames);
    }
    return [{ data: out, atMs: 0 }];
  }

  /** 契约 decode 转发解码器（组合根按需用；混音主路径直接走 decoder.decode） */
  async decode(clip: AudioClipRef): Promise<DecodedAudio> {
    const pcm = await this.decoder.decode(clip);
    const { data, ...meta } = pcm;
    void data;
    return meta;
  }

  /** 单事件铺轨：时间映射（变速）→ 重采样（线性）→ 声道映射 → loop 平铺 → 音量/淡入淡出包络 → pan 摆位 */
  private layoutEvent(
    ev: AudioTimelineEvent,
    pcm: DecodedPcm,
    out: Float32Array,
    outFrames: number,
  ): void {
    const startFrame = Math.round((ev.globalAtMs / 1000) * this.sampleRate);
    if (startFrame >= outFrames) return;
    const srcRate = pcm.sampleRate;
    const srcCh = pcm.channels;
    const srcFrames = pcm.data.length / srcCh;
    const warp = resolveWarp(ev.warp, pcm.durationMs);
    const space = outFrames - startFrame;
    // 事件输出帧数：loop = 铺到输出缓冲尽头；否则 = 源播完所需的局部时间线时长（受变速影响）
    const naturalFrames = Math.ceil(
      (timelineMsAtSource(warp, pcm.durationMs) / 1000) * this.sampleRate,
    );
    const total = ev.loop ? space : Math.min(naturalFrames, space);
    const gainBase = ev.volume;
    const fadeInFr = msToFrames(ev.fadeIn ?? 0, this.sampleRate);
    const fadeOutFr = msToFrames(ev.fadeOut ?? 0, this.sampleRate);
    for (let i = 0; i < total; i++) {
      // 时间线局部毫秒 → 源内毫秒；loop 在源空间回卷，越界（非 loop）静音收尾
      const localMs = (i * 1000) / this.sampleRate;
      const srcIdxF = (sourceMsAt(warp, localMs) / 1000) * srcRate;
      const wrapped = ev.loop ? srcIdxF % srcFrames : srcIdxF;
      if (!ev.loop && wrapped >= srcFrames) break;
      const s0 = Math.floor(wrapped);
      const frac = wrapped - s0;
      let gain = gainBase;
      if (fadeInFr > 0 && i < fadeInFr) gain *= i / fadeInFr;
      if (fadeOutFr > 0 && i >= total - fadeOutFr)
        gain *= (total - i) / fadeOutFr;
      for (let ch = 0; ch < this.channels; ch++) {
        const s = sampleAt(pcm, s0, frac, ch, srcCh);
        const idx = (startFrame + i) * this.channels + ch;
        out[idx]! += s * gain * panGain(ev.pan, ch, this.channels);
      }
    }
  }
}

/** ms → 输出帧数 */
function msToFrames(ms: Ms, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

/** 交错 PCM 线性插值取样（声道越界回卷；单声道源映射到多声道时复制） */
function sampleAt(
  pcm: DecodedPcm,
  frame: number,
  frac: number,
  ch: number,
  srcCh: number,
): number {
  const srcChIdx = srcCh === 1 ? 0 : Math.min(ch, srcCh - 1);
  const i0 = frame * srcCh + srcChIdx;
  const i1 = i0 + srcCh;
  const v0 = pcm.data[i0] ?? 0;
  if (frac === 0) return v0;
  const v1 = frame + 1 < pcm.data.length / srcCh ? (pcm.data[i1] ?? 0) : v0;
  return v0 + (v1 - v0) * frac;
}

/** 立体声摆位增益：-1 全左 / 1 全右；非立体声输出恒 1 */
function panGain(pan: number, ch: number, outCh: number): number {
  if (outCh !== 2 || pan === 0) return 1;
  const p = Math.max(-1, Math.min(1, pan));
  // 等功率摆位近似：线性增益（v0.1 简化，正弦律后续版本）
  return ch === 0 ? 1 - Math.max(0, p) : 1 - Math.max(0, -p);
}
