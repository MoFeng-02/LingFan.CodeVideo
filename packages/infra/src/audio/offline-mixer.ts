/**
 * 离线确定性混音器（AudioClock 契约的导出端实现）：
 * 样本 = 时间线纯函数——同程序必同输出（逐样本相同）。
 * 输入 = 引擎收集的声音程序（登记期 + 运行期）；输出 = 交错 Float32 PCM。
 * 混音走单一 DSP 内核（与预览端音频线程同一份实现），按块循环渲染整段。
 */
import type {
  AudioClock,
  AudioClip,
  AudioGraph,
  AudioProgram,
  AudioSample,
  AudioVoice,
  DecodedAudio,
} from "@lingfan-video/contracts";
import { mixProgram, type ProgramVoice } from "./dsp";
import { renderSynth } from "./synth";

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

const EMPTY_GRAPH: AudioGraph = {
  buses: [],
  sends: [],
  ducks: [],
  automation: [],
};

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
    const voices: ProgramVoice[] = [];
    for (const voice of program.voices)
      voices.push({ voice, pcm: await this.pcmOf(voice) });
    const data = mixProgram({
      sampleRate: this.sampleRate,
      channels: this.channels,
      durationMs: program.durationMs,
      voices,
      graph: program.graph ?? EMPTY_GRAPH,
    });
    return [{ data, atMs: 0 }];
  }

  /** 契约 decode 转发解码器 */
  async decode(clip: AudioClip): Promise<DecodedAudio> {
    const pcm = await this.decoder.decode(clip);
    const { data, ...meta } = pcm;
    void data;
    return meta;
  }

  /** 单个声音的 PCM：synth 走确定性合成，否则走素材解码 */
  private async pcmOf(voice: AudioVoice): Promise<DecodedPcm> {
    if (voice.synth) {
      const pcm = renderSynth(voice.synth, this.sampleRate, this.channels);
      return {
        clip: voice.clip,
        sampleRate: pcm.sampleRate,
        channels: pcm.channels,
        durationMs: pcm.durationMs,
        data: pcm.data,
      };
    }
    return this.decoder.decode(voice.clip);
  }
}
