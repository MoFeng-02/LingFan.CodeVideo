/**
 * 离线确定性混音器（AudioClock 契约的导出端实现）：
 * 样本 = 时间线纯函数——同程序必同输出（逐样本相同）。
 *
 * 输入 = 引擎收集的声音程序（登记期 + 运行期）；输出 = 交错 Float32 PCM。
 * 混音走单一 DSP 内核（与预览端音频线程同一份实现），按块循环渲染整段。
 * 与实时播放的差别：这里没有设备时钟与延迟，整段一次性算完，可重复得到同样字节。
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
  /**
   * 解码一条 clip。
   *
   * @param clip 音频素材（url + 品牌标记）
   * @returns 解码产物：交错样本 + 采样率/声道数/时长元数据
   */
  decode(clip: AudioClip): Promise<DecodedPcm>;
}

/** 解码产物：交错 Float32 PCM（声道数与时长由实现持有） */
export interface DecodedPcm extends DecodedAudio {
  /** 交错样本：长度 = frames × channels */
  data: Float32Array;
}

/** 离线输出布局选项（采样率/声道数是导出目标的编码参数） */
export interface OfflineAudioMixerOptions {
  /** 输出采样率（导出目标；缺省 48000） */
  sampleRate?: number;
  /** 输出声道数（导出布局；缺省 2） */
  channels?: number;
}

/** 缺省输出采样率（Hz） */
const DEFAULT_SAMPLE_RATE = 48_000;
/** 缺省输出声道数 */
const DEFAULT_CHANNELS = 2;

/** 程序未声明总线图时使用的中性图（无总线、无发送、无压制、无自动化） */
const EMPTY_GRAPH: AudioGraph = {
  buses: [],
  sends: [],
  ducks: [],
  automation: [],
};

/** OfflineAudioMixer：AudioClock 契约的导出端实现（样本=时间线纯函数） */
export class OfflineAudioMixer implements AudioClock {
  /** 输出采样率（Hz），构造时定死 */
  readonly sampleRate: number;
  /** 输出声道数，构造时定死 */
  readonly channels: number;

  /**
   * @param decoder 素材解码器（平台适配器注入）
   * @param options 输出布局；缺省 48000 Hz / 2 声道
   */
  constructor(
    private readonly decoder: AudioDecoder,
    options?: OfflineAudioMixerOptions,
  ) {
    this.sampleRate = options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.channels = options?.channels ?? DEFAULT_CHANNELS;
  }

  /**
   * 混音整条程序：每个声音按求值时间线铺入输出缓冲（多实例叠加、loop 平铺、包络逐样本）。
   *
   * 输出只有一段、从 0 毫秒起，长度由程序时长决定；同一程序重复调用逐样本一致。
   *
   * @param program 声音程序：总时长（毫秒）、声音列表、可选总线图
   * @returns 单段交错 PCM（atMs 恒为 0）
   */
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

  /**
   * 契约 decode 转发解码器：只回元数据，样本丢弃（`AudioClock.decode` 的调用方只要时长/布局）。
   *
   * @param clip 音频素材
   * @returns 解码元数据（clip/采样率/声道数/时长），不含样本
   */
  async decode(clip: AudioClip): Promise<DecodedAudio> {
    const pcm = await this.decoder.decode(clip);
    const { data, ...meta } = pcm;
    void data;
    return meta;
  }

  /**
   * 单个声音的 PCM：synth 走确定性合成，否则走素材解码。
   *
   * 合成结果按本混音器的输出采样率与声道数生成，因此与输出布局天然对齐；
   * 素材解码结果的采样率/声道数由解码器决定，混音内核会做重采样与声道折叠。
   *
   * @param voice 声音（含 clip，可选 synth）
   * @returns 交错 PCM 与元数据
   */
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
