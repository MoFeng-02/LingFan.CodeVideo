/** WebAudio 实时预览适配器（AudioOutput 契约的预览端实现）：边跑边发。 */
import type {
  AudioGraph,
  AudioOutput,
  AudioProgram,
  AudioVoice,
  BusId,
  BusUpdate,
  LiveVoice,
  Ms,
} from "@lingfan-video/contracts";
import { applyBusParams, buildBusGraph } from "./buses";
import { scheduleSynth, scheduleVoice } from "./schedule";
import type { AudioBufferLoader, BusNode, PlayerEnv } from "./types";

/** 预排提前量（秒）：给加载与调度留余量，避免起点被吞 */
const SCHEDULE_LEAD_SEC = 0.06;

/** 设备延迟补偿上限（毫秒）：异常大的 outputLatency 宁可少补也不要让画面倒退太多 */
const LATENCY_CLAMP_MS = 250;

const NOOP = (): void => {};

export class WebAudioOutput implements AudioOutput {
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly loaded = new Map<string, Promise<AudioBuffer>>();
  private startedAtSec = 0;
  private latencyMs = 0;
  private programDurationMs = 0;
  private buses = new Map<BusId, BusNode>();
  private busParams = new Map<BusId, BusUpdate>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly load: AudioBufferLoader,
  ) {}

  /** 锚定时间线起点：预加载并预排登记期声音 */
  async begin(program: AudioProgram): Promise<void> {
    this.dispose();
    this.startedAtSec = this.ctx.currentTime + SCHEDULE_LEAD_SEC;
    this.latencyMs = this.measureLatencyMs();
    this.programDurationMs = program.durationMs;
    this.buildBuses(program.graph);
    await Promise.all(
      program.voices
        .filter((v) => !v.synth)
        .map((v) => this.bufferOf(v.clip.url)),
    );
    for (const voice of program.voices) this.schedule(voice);
  }

  /** 运行期发射：即时排程（起点已过则从偏移接上） */
  start(voice: AudioVoice): LiveVoice {
    const live = this.schedule(voice);
    if (live) return live;
    // 缓冲尚未就绪或已过终点：返回空操作句柄，调用语义不报错（预览可丢，导出不丢）
    return { stop: NOOP, setGain: NOOP, setRate: NOOP };
  }

  /** 清场（重播/切幕） */
  dispose(): void {
    for (const n of this.sources.splice(0)) {
      try {
        n.stop();
      } catch {
        // 未开始的节点 stop 抛 InvalidStateError，忽略
      }
    }
    for (const bus of this.buses.values()) {
      try {
        bus.input.disconnect();
        bus.gain.disconnect();
        bus.panner?.disconnect();
      } catch {
        // 已断开
      }
    }
    this.buses.clear();
    this.busParams.clear();
  }

  /** 运行期总线参数更新：gain/pan 直接改节点，mute = gain 归零；solo 由重算统一处理 */
  setBus(update: BusUpdate): void {
    if (!this.buses.has(update.id)) return;
    this.busParams.set(update.id, update);
    applyBusParams(this.env(), update.id, update.rampMs ?? 0);
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

  /** 按 program.graph 建总线节点图（拓扑固定；缺省 = 声音直连 destination） */
  private buildBuses(graph: AudioGraph | undefined): void {
    const built = buildBusGraph(this.ctx, graph);
    this.buses = built.buses;
    this.busParams = built.params;
  }

  private bufferOf(url: string): Promise<AudioBuffer> {
    const hit = this.loaded.get(url);
    if (hit) return hit;
    const p = this.load(url);
    this.loaded.set(url, p);
    return p;
  }

  /** 全局时间线毫秒 → 上下文秒（已过起点时为负） */
  private ctxSecOf(globalMs: Ms): number {
    return this.startedAtSec + globalMs / 1000;
  }

  private schedule(voice: AudioVoice): LiveVoice | null {
    return voice.synth
      ? scheduleSynth(this.env(), voice)
      : scheduleVoice(this.env(), voice);
  }

  /** 排程模块看到的上下文：活动节点表与时间换算 */
  private env(): PlayerEnv {
    return {
      ctx: this.ctx,
      buses: this.buses,
      busParams: this.busParams,
      sources: this.sources,
      programDurationMs: this.programDurationMs,
      ctxSecOf: (ms) => this.ctxSecOf(ms),
      nowMs: () => this.nowMs(),
      bufferOf: (url) => this.bufferOf(url),
    };
  }
}
