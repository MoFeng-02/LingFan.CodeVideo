/**
 * WebAudio 实时预览适配器（AudioOutput 契约的预览端实现）。
 *
 * 预览不再用内建节点拼效果链：所有声音解码成 PCM 后交给音频线程，
 * 由与导出端同一份混音内核逐块渲染。因此音色与导出同源，
 * 两端剩下的差别只有设备延迟与浏览器调度抖动。
 */
import type {
  AudioOutput,
  AudioProgram,
  AudioVoice,
  BusUpdate,
  LiveVoice,
  Ms,
} from "@lingfan-video/contracts";
import { renderSynth } from "../synth";
import {
  MIXER_PROCESSOR,
  type MixerAck,
  type MixerMessage,
  type PcmPayload,
} from "../worklet/protocol";
import type { AudioBufferLoader } from "./types";

/** 输出声道数（预览与导出一致） */
const CHANNELS = 2;

/** 设备延迟补偿上限（毫秒）：异常大的 outputLatency 宁可少补也不要让画面倒退太多 */
const LATENCY_CLAMP_MS = 250;

/** 缺省 worker 入口：由打包器把该 URL 当作模块资源 */
const DEFAULT_WORKLET_URL = new URL(
  "../worklet/preview-worklet.ts",
  import.meta.url,
).href;

const NOOP = (): void => {};

export interface WebAudioOutputOptions {
  /** worker 入口（缺省同目录的 worklet 模块；测试与宿主可覆盖） */
  readonly workletUrl?: string | URL;
}

export class WebAudioOutput implements AudioOutput {
  private node: AudioWorkletNode | null = null;
  private startedAtSec = 0;
  private latencyMs = 0;
  private readonly loaded = new Map<string, Promise<AudioBuffer>>();
  /** 已备好的单个声音 PCM（预热与正式播放共用：同一份样本只算一次） */
  private readonly pcmCache = new Map<string, Promise<PcmPayload>>();
  /** 预热中的 worker 模块（幂等；失败即清空，下次调用重新加载） */
  private prepared: Promise<void> | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly load: AudioBufferLoader,
    private readonly options?: WebAudioOutputOptions,
  ) {}

  /**
   * 预热：把 worker 模块取回并编译好，可以播放在用户操作之前。
   *
   * 为什么值得单列：模块加载与编译在开发服务器上可达秒级，而 `begin` 要等它完成才
   * 能把第一帧放出来——不预热，观众看到的是「点了播放没反应」。幂等：重复调用共用
   * 同一个 Promise，`begin` 也走这条路径，因此重播不会再等一次。失败不缓存（下次
   * 调用重试），错误照旧抛给调用方。
   */
  prepare(): Promise<void> {
    if (this.prepared === null) {
      this.prepared = this.loadWorklet().catch((error: unknown) => {
        this.prepared = null;
        throw error;
      });
    }
    return this.prepared;
  }

  /** 只负责把模块取回并编译；节点与程序留给 `begin`（预热不占音频线程） */
  private async loadWorklet(): Promise<void> {
    if (this.ctx.audioWorklet === undefined)
      throw new Error(
        "预览端需要 AudioWorklet：当前音频上下文不支持，无法与导出端共用同一份 DSP",
      );
    const url = String(this.options?.workletUrl ?? DEFAULT_WORKLET_URL);
    await this.ctx.audioWorklet.addModule(url);
  }

  /**
   * 预热：把程序里每个声部的 PCM 解码/合成好放进缓存，可以放在用户点播放之前。
   *
   * 预热只填缓存；真正开始播放仍由 begin() 负责——这里不建 AudioWorkletNode、
   * 不出声、也不动时间线锚点（nowMs 保持调用前的值），因此任何时刻调用都安全。
   * 幂等：重复调用命中缓存不重算（素材按 url 缓存、synth 按参数缓存）；
   * 任一声音失败即清空缓存并把错误抛给调用方，下一次调用从零重来。
   */
  async warm(program: AudioProgram): Promise<void> {
    try {
      await Promise.all(program.voices.map((voice) => this.pcmOf(voice)));
    } catch (error) {
      this.pcmCache.clear();
      this.loaded.clear();
      throw error;
    }
  }

  /** 锚定时间线起点：模块就绪后投递整条程序、等音频线程开声 */
  async begin(program: AudioProgram): Promise<void> {
    this.dispose();
    this.latencyMs = this.measureLatencyMs();
    await this.prepare();
    const node = new AudioWorkletNode(this.ctx, MIXER_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
    });
    this.node = node;
    const payloads: { voice: AudioVoice; pcm: PcmPayload }[] = [];
    for (const voice of program.voices)
      payloads.push({ voice, pcm: await this.pcmOf(voice) });
    node.port.postMessage({
      type: "init",
      sampleRate: this.ctx.sampleRate,
      channels: CHANNELS,
      durationMs: program.durationMs,
      graph: program.graph ?? EMPTY_GRAPH,
    } satisfies MixerMessage);
    for (const payload of payloads) {
      const message = voiceMessage(payload);
      node.port.postMessage(message.data, message.transfer);
    }
    let resolveStarted: () => void = NOOP;
    let rejectStarted: (error: Error) => void = NOOP;
    const opened = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    node.port.onmessage = (event: MessageEvent<MixerAck>) => {
      const ack = event.data;
      if (ack.type === "started") {
        this.startedAtSec = ack.atSec;
        resolveStarted();
      } else rejectStarted(new Error(ack.message));
    };
    node.connect(this.ctx.destination);
    await opened;
  }

  /** 运行期发射：解码后就地投递（起点已过时内核从当前位置接上） */
  start(voice: AudioVoice): LiveVoice {
    const handle: LiveVoice = {
      stop: (atMs, fadeMs) =>
        this.post({ type: "stop", voiceId: voice.id, atMs, fadeMs }),
      setGain: (atMs, value, rampMs) =>
        this.post({ type: "gain", voiceId: voice.id, atMs, value, rampMs }),
      setRate: (atMs, value) =>
        this.post({ type: "rate", voiceId: voice.id, atMs, value }),
    };
    void this.pcmOf(voice)
      .then((pcm) => {
        const message = voiceMessage({ voice, pcm });
        this.node?.port.postMessage(message.data, message.transfer);
      })
      .catch(() => {
        // 预览允许丢声：加载失败时句柄仍可调用，只是没有声音
      });
    return handle;
  }

  /** 运行期总线参数更新：交给音频线程在同一时间轴上生效 */
  setBus(update: BusUpdate): void {
    this.post({ type: "bus", update, atMs: update.at ?? this.nowMs() });
  }

  /** 清场（重播/切幕） */
  dispose(): void {
    const node = this.node;
    this.node = null;
    if (!node) return;
    node.port.onmessage = null;
    try {
      node.disconnect();
    } catch {
      // 已断开
    }
  }

  /** 兼容旧名：等同 dispose */
  stop(): void {
    this.dispose();
  }

  /**
   * 当前时间线位置（毫秒）：以 begin 锚定的起点为零点，供预览端按同一主时钟排帧。
   *
   * 减去设备延迟：音频上下文里 X 秒排下的样本，要再过 baseLatency + outputLatency
   * 才真正从扬声器出来。画面若按 ctx.currentTime 推进，就会比听到的声音早这几毫秒；
   * 这里把时钟整体后移，让「看到的帧」与「听到的样本」在同一时刻对齐。
   */
  nowMs(): Ms {
    return (this.ctx.currentTime - this.startedAtSec) * 1000 - this.latencyMs;
  }

  /** 设备延迟（毫秒）：取上下文自报的两段延迟之和并钳到上限；未知按 0 处理 */
  private measureLatencyMs(): number {
    const ctx = this.ctx as AudioContext & {
      readonly baseLatency?: number;
      readonly outputLatency?: number;
    };
    const total =
      (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency! : 0) +
      (Number.isFinite(ctx.outputLatency) ? ctx.outputLatency! : 0);
    return Math.min(LATENCY_CLAMP_MS, Math.max(0, total * 1000));
  }

  private post(message: MixerMessage): void {
    this.node?.port.postMessage(message);
  }

  private bufferOf(url: string): Promise<AudioBuffer> {
    const hit = this.loaded.get(url);
    if (hit) return hit;
    const p = this.load(url);
    this.loaded.set(url, p);
    return p;
  }

  /**
   * 单个声音的 PCM（缓存）：synth 现场合成，素材走加载器后转成交错布局。
   * 预热与播放取的是同一份缓存——重复播放不必重算整条配乐。
   */
  private pcmOf(voice: AudioVoice): Promise<PcmPayload> {
    const key = pcmKey(voice);
    const hit = this.pcmCache.get(key);
    if (hit) return hit;
    const pending = this.decodePcm(voice).catch((error: unknown) => {
      // 失败不留在缓存里：下次调用（预热或 begin/start）重新解码
      if (this.pcmCache.get(key) === pending) this.pcmCache.delete(key);
      throw error;
    });
    this.pcmCache.set(key, pending);
    return pending;
  }

  /** 真正的解码/合成（不含缓存：synth 现场算，素材经加载器） */
  private async decodePcm(voice: AudioVoice): Promise<PcmPayload> {
    if (voice.synth)
      return renderSynth(voice.synth, this.ctx.sampleRate, CHANNELS);
    const buffer = await this.bufferOf(voice.clip.url);
    return interleave(buffer, this.ctx.sampleRate, CHANNELS);
  }
}

/**
 * PCM 缓存键：样本只由「合成参数」或「素材 url」决定（采样率与声道数是实例常量），
 * 与声部 id 无关——预热用的程序与正式推演是两次编译，声部对象不同但样本相同。
 */
function pcmKey(voice: AudioVoice): string {
  return voice.synth
    ? `synth:${JSON.stringify(voice.synth)}`
    : `clip:${voice.clip.url}`;
}

/** 声音消息：PCM 缓冲以转移方式交给音频线程（缓存那份要留给重播，先复制） */
function voiceMessage(payload: { voice: AudioVoice; pcm: PcmPayload }): {
  data: MixerMessage;
  transfer: Transferable[];
} {
  const pcm: PcmPayload = {
    data: payload.pcm.data.slice(),
    sampleRate: payload.pcm.sampleRate,
    channels: payload.pcm.channels,
    durationMs: payload.pcm.durationMs,
  };
  const data: MixerMessage = { type: "voice", voice: payload.voice, pcm };
  return { data, transfer: [pcm.data.buffer] };
}

/** AudioBuffer → 交错 PCM（声道不足复制、过多取前两路；采样率不同则线性重采样） */
function interleave(
  buffer: AudioBuffer,
  sampleRate: number,
  channels: number,
): PcmPayload {
  const srcFrames = buffer.length;
  const srcRate = buffer.sampleRate;
  const frames =
    srcRate === sampleRate
      ? srcFrames
      : Math.max(1, Math.round((srcFrames / srcRate) * sampleRate));
  const data = new Float32Array(frames * channels);
  const sources = Array.from({ length: channels }, (_, ch) =>
    buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1)),
  );
  for (let i = 0; i < frames; i++) {
    const pos = srcRate === sampleRate ? i : (i / sampleRate) * srcRate;
    const i0 = Math.min(srcFrames - 1, Math.floor(pos));
    const i1 = Math.min(srcFrames - 1, i0 + 1);
    const frac = pos - i0;
    for (let ch = 0; ch < channels; ch++) {
      const a = sources[ch]![i0]!;
      const b = sources[ch]![i1]!;
      data[i * channels + ch] = a + (b - a) * frac;
    }
  }
  return {
    data,
    sampleRate,
    channels,
    durationMs: (frames / sampleRate) * 1000,
  };
}

/** 无总线图时的空图（与导出端缺省行为一致：声音直连 master） */
const EMPTY_GRAPH = {
  buses: [],
  sends: [],
  ducks: [],
  automation: [],
} as const;
