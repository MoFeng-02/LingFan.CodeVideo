/**
 * 离线确定性混音器（AudioClock 契约的导出端实现）：
 * 样本 = 时间线纯函数——同程序必同输出（逐样本相同）。
 * 输入 = 引擎收集的声音程序（登记期 + 运行期）；输出 = 交错 Float32 PCM。
 * 单个声音的时间映射/包络一律走 `evaluateVoice`（与预览端同一求值点）。
 */
import type {
  AudioClock,
  AudioClip,
  AudioProgram,
  AudioSample,
  AudioVoice,
  DecodedAudio,
  Ms,
} from "@lingfan-video/contracts";
import { mixBusGraph } from "./bus-mixer";
import { evaluateVoice } from "./voice-timeline";

/** 离线解码器：把 clip 变成交错 Float32 PCM（平台适配器注入；Node 测试用合成器替代） */
export interface AudioDecoder {
  decode(clip: AudioClip): Promise<DecodedPcm>;
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

  /** 混音整条程序：每个声音按求值时间线铺入输出缓冲（多实例叠加、loop 平铺、包络逐样本） */
  async renderProgram(program: AudioProgram): Promise<AudioSample[]> {
    const frames = Math.max(
      1,
      Math.ceil((program.durationMs / 1000) * this.sampleRate),
    );
    const cache = new Map<string, DecodedPcm>();
    for (const voice of program.voices)
      await this.decodeCached(cache, voice.clip);
    // 无音频图（旧程序）→ 直连 master 的快速路径；有图 → 走总线混音
    if (!hasGraph(program.graph)) {
      const out = new Float32Array(frames * this.channels);
      for (const voice of program.voices) {
        const pcm = cache.get(voice.clip.url)!;
        this.layoutVoice(voice, pcm, out, frames, program.durationMs);
      }
      return [{ data: out, atMs: 0 }];
    }
    const out = mixBusGraph({
      sampleRate: this.sampleRate,
      channels: this.channels,
      frames,
      durationMs: program.durationMs,
      voices: program.voices,
      graph: program.graph!,
      layoutVoice: (voice, target, outFrames, durationMs) => {
        const pcm = cache.get(voice.clip.url)!;
        this.layoutVoice(voice, pcm, target, outFrames, durationMs);
      },
    });
    return [{ data: out, atMs: 0 }];
  }

  /** 契约 decode 转发解码器 */
  async decode(clip: AudioClip): Promise<DecodedAudio> {
    const pcm = await this.decoder.decode(clip);
    const { data, ...meta } = pcm;
    void data;
    return meta;
  }

  private async decodeCached(
    cache: Map<string, DecodedPcm>,
    clip: AudioClip,
  ): Promise<DecodedPcm> {
    const hit = cache.get(clip.url);
    if (hit) return hit;
    const pcm = await this.decoder.decode(clip);
    cache.set(clip.url, pcm);
    return pcm;
  }

  /** 单声音铺轨：时间映射（含变速/运行期 setRate）→ 重采样（线性）→ 声道映射 → 包络 → pan */
  private layoutVoice(
    voice: AudioVoice,
    pcm: DecodedPcm,
    target: Float32Array,
    outFrames: number,
    durationMs: Ms,
  ): void {
    const tl = evaluateVoice(voice, pcm.durationMs, durationMs);
    if (tl.endMs <= tl.startMs) return;
    const startFrame = Math.round((tl.startMs / 1000) * this.sampleRate);
    if (startFrame >= outFrames) return;
    const endFrame = Math.min(
      outFrames,
      Math.round((tl.endMs / 1000) * this.sampleRate),
    );
    const srcRate = pcm.sampleRate;
    const srcCh = pcm.channels;
    const srcFrames = pcm.data.length / srcCh;
    for (let fr = startFrame; fr < endFrame; fr++) {
      const globalMs = (fr * 1000) / this.sampleRate;
      // 时间线毫秒 → 源内毫秒；loop 在源空间回卷，越界（非 loop）静音收尾
      const srcIdxF = (tl.sourceMsAt(globalMs) / 1000) * srcRate;
      const wrapped = tl.loop ? posMod(srcIdxF, srcFrames) : srcIdxF;
      if (!tl.loop && wrapped >= srcFrames) break;
      const gain = tl.gainAt(globalMs);
      if (gain <= 0) continue;
      const s0 = Math.floor(wrapped);
      const frac = wrapped - s0;
      for (let ch = 0; ch < this.channels; ch++) {
        const s = sampleAt(pcm, s0, frac, ch, srcCh);
        const idx = fr * this.channels + ch;
        target[idx]! += s * gain * panGain(tl.pan, ch, this.channels);
      }
    }
  }
}

function hasGraph(graph: AudioProgram["graph"]): boolean {
  if (!graph) return false;
  return (
    graph.buses.length > 0 ||
    graph.sends.length > 0 ||
    graph.ducks.length > 0 ||
    graph.automation.length > 0
  );
}

function posMod(v: number, n: number): number {
  if (n <= 0) return 0;
  const m = v % n;
  return m < 0 ? m + n : m;
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
