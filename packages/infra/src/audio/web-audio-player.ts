/**
 * WebAudio 实时预览适配器（AudioOutput 契约的预览端实现）：边跑边发。
 * begin 预加载并预排登记期声音；start 承接运行期 ctx.audio 发射；
 * 时间映射/包络与导出端共用 `evaluateVoice`（同一求值点，预览与导出不漂移）。
 * 仅浏览器环境可用（AudioContext 为平台 API）；Node 下不要装配。
 */
import type {
  AudioGraph,
  AudioOutput,
  AudioProgram,
  AudioVoice,
  BusId,
  BusSpec,
  BusUpdate,
  LiveVoice,
  Ms,
} from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import { rateSegments, resolveWarp } from "./warp";
import { seededRandom, synthAmpEnvelopePoints, synthSeed } from "./synth";
import { evaluateVoice } from "./voice-timeline";

/** 资源加载：把 clip url 变成 AudioBuffer（宿主注入，通常 fetch + decodeAudioData） */
export type AudioBufferLoader = (url: string) => Promise<AudioBuffer>;

/** 预排提前量（秒）：给加载与调度留余量，避免起点被吞 */
const SCHEDULE_LEAD_SEC = 0.06;

interface BusNode {
  spec: BusSpec;
  input: GainNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
  tail: AudioNode;
}

export class WebAudioOutput implements AudioOutput {
  private readonly nodes: AudioBufferSourceNode[] = [];
  private readonly loaded = new Map<string, Promise<AudioBuffer>>();
  private startedAtSec = 0;
  private programDurationMs = 0;
  private readonly buses = new Map<BusId, BusNode>();
  private readonly busParams = new Map<BusId, BusUpdate>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly load: AudioBufferLoader,
  ) {}

  /** 锚定时间线起点：预加载并预排登记期声音 */
  async begin(program: AudioProgram): Promise<void> {
    this.dispose();
    this.startedAtSec = this.ctx.currentTime + SCHEDULE_LEAD_SEC;
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
    const noop = (): void => {};
    return { stop: noop, setGain: noop, setRate: noop };
  }

  /** 清场（重播/切幕） */
  dispose(): void {
    for (const n of this.nodes.splice(0)) {
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
    const bus = this.buses.get(update.id);
    if (!bus) return;
    this.busParams.set(update.id, update);
    this.applyBusParams(update.id, update.rampMs ?? 0);
  }

  /** 按 program.graph 建总线节点图（拓扑固定；缺省 = 声音直连 destination） */
  private buildBuses(graph: AudioGraph | undefined): void {
    const specs = new Map<BusId, BusSpec & { parent?: BusId }>();
    specs.set(MASTER_BUS, { id: MASTER_BUS });
    for (const b of graph?.buses ?? []) specs.set(b.id, b);
    for (const [id, spec] of specs) {
      const input = this.ctx.createGain();
      const gain = this.ctx.createGain();
      const panner = id === MASTER_BUS ? null : this.ctx.createStereoPanner();
      let tail: AudioNode = input;
      for (const eff of spec.effects ?? []) {
        if (eff.kind === "filter") {
          const filter = this.ctx.createBiquadFilter();
          filter.type =
            eff.type === "lowpass"
              ? "lowpass"
              : eff.type === "highpass"
                ? "highpass"
                : "bandpass";
          filter.frequency.value = eff.frequency;
          filter.Q.value = eff.q ?? Math.SQRT1_2;
          tail.connect(filter);
          tail = filter;
        } else if (eff.kind === "compressor") {
          const comp = this.ctx.createDynamicsCompressor();
          comp.threshold.value = eff.thresholdDb;
          comp.ratio.value = eff.ratio;
          comp.attack.value = eff.attackMs / 1000;
          comp.release.value = eff.releaseMs / 1000;
          comp.knee.value = eff.kneeDb ?? 6;
          tail.connect(comp);
          tail = comp;
        } else if (eff.kind === "delay") {
          const delay = this.ctx.createDelay(5);
          delay.delayTime.value = Math.max(0.001, eff.delayMs / 1000);
          const fb = this.ctx.createGain();
          fb.gain.value = Math.max(0, Math.min(0.95, eff.feedback ?? 0.3));
          const wet = this.ctx.createGain();
          wet.gain.value = Math.max(0, Math.min(1, eff.mix ?? 0.5));
          const dry = this.ctx.createGain();
          dry.gain.value = 1 - wet.gain.value;
          const merge = this.ctx.createGain();
          tail.connect(dry);
          dry.connect(merge);
          tail.connect(delay);
          delay.connect(wet);
          wet.connect(merge);
          delay.connect(fb);
          fb.connect(delay);
          tail = merge;
        } else {
          const conv = this.ctx.createConvolver();
          conv.buffer = makeReverbImpulse(this.ctx, eff);
          const wet = this.ctx.createGain();
          wet.gain.value = Math.max(0, Math.min(1, eff.mix ?? 0.35));
          const dry = this.ctx.createGain();
          dry.gain.value = 1 - wet.gain.value;
          const merge = this.ctx.createGain();
          tail.connect(dry);
          dry.connect(merge);
          tail.connect(conv);
          conv.connect(wet);
          wet.connect(merge);
          tail = merge;
        }
      }
      tail.connect(gain);
      let out: AudioNode = gain;
      if (panner) {
        gain.connect(panner);
        out = panner;
      }
      this.buses.set(id, { spec, input, gain, panner, tail: out });
      const p = {
        id,
        gain: spec.gain ?? 1,
        pan: spec.pan ?? 0,
        mute: spec.mute ?? false,
        solo: spec.solo ?? false,
      };
      this.busParams.set(id, p);
    }
    // 父链接线（父总线的效果输入即子总线的汇入点）
    for (const [id, bus] of this.buses) {
      if (id === MASTER_BUS) {
        bus.tail.connect(this.ctx.destination);
        continue;
      }
      const parentId =
        bus.spec.parent && this.buses.has(bus.spec.parent)
          ? bus.spec.parent
          : MASTER_BUS;
      bus.tail.connect(this.buses.get(parentId)!.input);
    }
    // 发送（预览端用节点直接实现，与导出端语义一致）
    for (const send of graph?.sends ?? []) {
      const from = this.buses.get(send.from);
      const to = this.buses.get(send.to);
      if (!from || !to) continue;
      const amount = this.ctx.createGain();
      amount.gain.value = send.pre ? send.amount : send.amount;
      from.tail.connect(amount);
      amount.connect(to.input);
    }
    for (const b of this.buses.keys()) this.applyBusParams(b, 0);
  }

  /** 计算并应用单总线有效参数（solo 期间未 solo 的总线静音；master 不受 solo 影响） */
  private applyBusParams(id: BusId, rampMs: number): void {
    const bus = this.buses.get(id);
    if (!bus) return;
    const p = this.busParams.get(id);
    if (!p) return;
    const soloActive = [...this.busParams.entries()].some(
      ([b, v]) => b !== MASTER_BUS && v.solo,
    );
    const muted = p.mute || (soloActive && !p.solo && id !== MASTER_BUS);
    const target = muted ? 0 : p.gain;
    const when = Math.max(this.ctx.currentTime, this.ctxSecOf(this.nowMs()));
    const param = bus.gain.gain;
    // 测试替身可能只实现 setValueAtTime/linearRamp（无 cancelScheduledValues）——可选调用
    if (typeof param.cancelScheduledValues === "function")
      param.cancelScheduledValues(when);
    param.setValueAtTime(param.value, when);
    if (rampMs > 0) param.linearRampToValueAtTime(target, when + rampMs / 1000);
    else param.setValueAtTime(target, when);
    if (bus.panner) {
      const pan = bus.panner.pan;
      if (typeof pan.cancelScheduledValues === "function")
        pan.cancelScheduledValues(when);
      pan.setValueAtTime(pan.value, when);
      if (rampMs > 0)
        pan.linearRampToValueAtTime(
          Math.max(-1, Math.min(1, p.pan)),
          when + rampMs / 1000,
        );
      else pan.setValueAtTime(Math.max(-1, Math.min(1, p.pan)), when);
    }
  }

  /** 兼容旧名：等同 dispose */
  stop(): void {
    this.dispose();
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

  /** 单声音节点图：source（含变速自动化）→ gain（包络）→ [pan] → destination */
  private schedule(voice: AudioVoice): LiveVoice | null {
    if (voice.synth) return this.scheduleSynth(voice);
    const pending = this.bufferOf(voice.clip.url);
    let src: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let start = 0;
    let end = 0;
    let tl: ReturnType<typeof evaluateVoice> | null = null;

    pending
      .then((buffer) => {
        tl = evaluateVoice(
          voice,
          buffer.duration * 1000,
          this.programDurationMs,
        );
        if (tl.endMs <= Math.max(tl.startMs, this.nowMs())) return;
        start = this.ctxSecOf(tl.startMs);
        end = this.ctxSecOf(tl.endMs);
        src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = voice.loop !== null;
        this.applyRate(
          src.playbackRate,
          voice,
          tl.startMs,
          buffer.duration * 1000,
        );
        gain = this.ctx.createGain();
        this.applyGain(gain.gain, tl.gainPoints, end);
        let tail: AudioNode = gain;
        if (Math.abs(tl.pan) > 0) {
          const panner = this.ctx.createStereoPanner();
          panner.pan.value = Math.max(-1, Math.min(1, tl.pan));
          gain.connect(panner);
          tail = panner;
        }
        src.connect(gain);
        const targetBus =
          (voice.bus && this.buses.get(voice.bus)?.input) ||
          this.buses.get(MASTER_BUS)?.input ||
          this.ctx.destination;
        tail.connect(targetBus);
        src.start(
          Math.max(start, this.ctx.currentTime),
          Math.max(0, tl.sourceMsAt(tl.startMs) / 1000),
        );
        // 终点显式收声并释放：loop 源本身无限长，不 stop 会越过时间线尾一直响
        src.stop(end);
        this.nodes.push(src);
      })
      .catch(() => {
        // 预览加载失败不打断渲染（导出端由 AudioClock 自己报错）
      });

    const at = (globalMs: Ms): number =>
      Math.max(this.ctxSecOf(globalMs), this.ctx.currentTime);

    return {
      stop: (atMs, fadeMs) => {
        if (!src || !gain) return;
        const stopAt = this.ctxSecOf(atMs);
        const fadeFrom = Math.max(this.ctx.currentTime, stopAt - fadeMs / 1000);
        gain.gain.setValueAtTime(gain.gain.value, fadeFrom);
        gain.gain.linearRampToValueAtTime(0, stopAt);
        try {
          src.stop(stopAt);
        } catch {
          // 已停止
        }
      },
      setGain: (atMs, value, rampMs) => {
        if (!gain) return;
        const t = at(atMs);
        gain.gain.setValueAtTime(gain.gain.value, t);
        if (rampMs > 0)
          gain.gain.linearRampToValueAtTime(value, t + rampMs / 1000);
        else gain.gain.setValueAtTime(value, t);
      },
      setRate: (atMs, value, rampMs) => {
        if (!src) return;
        const t = at(atMs);
        const p = src.playbackRate;
        p.setValueAtTime(p.value, t);
        if (rampMs > 0) p.linearRampToValueAtTime(value, t + rampMs / 1000);
        else p.setValueAtTime(value, t);
      },
    };
  }

  /**
   * 程序化音源排程：振荡器/噪声源 + ADSR 自动化 + 声音增益，
   * 与导出端共用同一组包络折点（时值由 spec.durationMs 决定）。
   * 包络与声音增益各自一个增益节点串联：两个线性斜坡相乘即导出端的逐样本乘积，
   * 合进同一个节点则只能按折点取积再线性插值，段内会与导出端偏离。
   * 预览端振荡器不复刻 rate/warp 的逐样本细节，音高与时长一致。
   */
  private scheduleSynth(voice: AudioVoice): LiveVoice | null {
    const spec = voice.synth!;
    const tl = evaluateVoice(voice, spec.durationMs, this.programDurationMs);
    if (tl.endMs <= tl.startMs) return null;
    const start = Math.max(this.ctxSecOf(tl.startMs), this.ctx.currentTime);
    const end = this.ctxSecOf(tl.endMs);
    const ampGain = this.ctx.createGain();
    this.applyGain(ampGain.gain, synthAmpEnvelopePoints(spec), end);
    const gain = this.ctx.createGain();
    this.applyGain(gain.gain, tl.gainPoints, end);
    let src: AudioScheduledSourceNode;
    let osc: OscillatorNode | null = null;
    let rateParam: AudioParam | null = null;
    if (spec.wave === "noise") {
      const frames = Math.max(
        1,
        Math.round((spec.durationMs / 1000) * this.ctx.sampleRate),
      );
      const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      const rnd = seededRandom(synthSeed(spec));
      for (let i = 0; i < frames; i++) data[i] = rnd() * 2 - 1;
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      src = node;
    } else {
      osc = this.ctx.createOscillator();
      osc.type =
        spec.wave === "saw"
          ? "sawtooth"
          : spec.wave === "triangle"
            ? "triangle"
            : spec.wave === "square"
              ? "square"
              : "sine";
      osc.frequency.value = Math.max(0.01, spec.freq);
      osc.detune.value = spec.detune ?? 0;
      rateParam = osc.detune;
      src = osc;
    }
    src.connect(ampGain);
    ampGain.connect(gain);
    let tail: AudioNode = gain;
    if (Math.abs(tl.pan) > 0) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, tl.pan));
      gain.connect(panner);
      tail = panner;
    }
    const targetBus =
      (voice.bus && this.buses.get(voice.bus)?.input) ||
      this.buses.get(MASTER_BUS)?.input ||
      this.ctx.destination;
    tail.connect(targetBus);
    src.start(start);
    src.stop(end);
    this.nodes.push(src as AudioBufferSourceNode);
    const at = (globalMs: Ms): number =>
      Math.max(this.ctxSecOf(globalMs), this.ctx.currentTime);
    return {
      stop: (atMs, fadeMs) => {
        const stopAt = this.ctxSecOf(atMs);
        const fadeFrom = Math.max(this.ctx.currentTime, stopAt - fadeMs / 1000);
        gain.gain.setValueAtTime(gain.gain.value, fadeFrom);
        gain.gain.linearRampToValueAtTime(0, stopAt);
        try {
          src.stop(stopAt);
        } catch {
          // 已停止
        }
      },
      setGain: (atMs, value, rampMs) => {
        const t = at(atMs);
        gain.gain.setValueAtTime(gain.gain.value, t);
        if (rampMs > 0)
          gain.gain.linearRampToValueAtTime(value, t + rampMs / 1000);
        else gain.gain.setValueAtTime(value, t);
      },
      setRate: (atMs, value, rampMs) => {
        if (!rateParam || !osc) return;
        const t = at(atMs);
        const cents = 1200 * Math.log2(Math.max(1e-6, value));
        rateParam.setValueAtTime(rateParam.value, t);
        if (rampMs > 0)
          rateParam.linearRampToValueAtTime(cents, t + rampMs / 1000);
        else rateParam.setValueAtTime(cents, t);
      },
    };
  }

  /**
   * 变速自动化：warp 锚点斜率 / 恒速率 → playbackRate 分段（与导出端同一张表）。
   * playbackRate 重采样即磁带式变调，预览与离线混音的音高/时长一致。
   */
  private applyRate(
    param: AudioParam,
    voice: AudioVoice,
    startMs: Ms,
    sourceDurationMs: Ms,
  ): void {
    const start = this.ctxSecOf(startMs);
    const rate = voice.rate;
    if (!rate) return;
    if (rate.kind === "rate") {
      param.setValueAtTime(rate.value, Math.max(start, this.ctx.currentTime));
      return;
    }
    const w = resolveWarp(rate.points, sourceDurationMs);
    const segs = rateSegments(w);
    for (const seg of segs) {
      const t = Math.max(start + seg.fromMs / 1000, this.ctx.currentTime);
      param.setValueAtTime(seg.rate, t);
    }
  }

  /** 增益折线自动化（求值点给出的折点 → AudioParam 线性段），终点归零 */
  private applyGain(
    param: AudioParam,
    points: readonly { atMs: Ms; gain: number }[],
    endSec: number,
  ): void {
    const first = points[0];
    if (!first) return;
    param.setValueAtTime(first.gain, this.ctxSecOf(first.atMs));
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      param.linearRampToValueAtTime(p.gain, this.ctxSecOf(p.atMs));
    }
    param.setValueAtTime(0, endSec);
  }

  /** 当前时间线位置（毫秒）：以 begin 锚定的起点为零点，供预览端按同一主时钟排帧 */
  nowMs(): Ms {
    return (this.ctx.currentTime - this.startedAtSec) * 1000;
  }
}

/** 确定性混响 IR（衰减噪声；预览端音色近似，时序与导出端一致） */
function makeReverbImpulse(
  ctx: AudioContext,
  spec: { roomSize?: number; damping?: number },
): AudioBuffer {
  const seconds = 0.6 + (spec.roomSize ?? 0.7) * 1.6;
  const frames = Math.max(1, Math.round(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
  const rnd = seededRandom(6789);
  const decay = 2.2 + (spec.damping ?? 0.4) * 2;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      data[i] = (rnd() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buffer;
}
