/**
 * 单一混音内核：块处理的流式混音器。
 *
 * 导出端（Node/浏览器离线）按块循环渲染整段；预览端把同一个类放进 AudioWorklet，
 * 由音频线程逐块驱动。两条路径共用同一份状态与运算，因此两端音色同源；
 * 块尺寸只影响循环次数，不影响逐样本结果。
 */
import type {
  AudioGraph,
  AudioOp,
  AudioVoice,
  BusId,
  BusSpec,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import { DuckUnit } from "./duck";
import { createEffectUnits, type EffectUnit } from "./effects";
import {
  anySolo,
  makeAutomation,
  parentOf,
  topoOrder,
  type BusParams,
} from "./graph";
import { panGain } from "./math";
import type { ProgramVoice, VoicePcm } from "./types";
import { layVoice, planVoice, type VoicePlan } from "./voice";

/** 缺省块尺寸（帧）：128 帧在 48kHz 下约 2.7ms，与音频工作线程的渲染量子一致 */
export const DEFAULT_BLOCK_FRAMES = 128;

export interface StreamingMixerOptions {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: Ms;
  readonly graph: AudioGraph;
  readonly blockFrames?: number;
}

export interface MixProgramInput extends StreamingMixerOptions {
  readonly voices: readonly ProgramVoice[];
}

interface BusRuntime {
  readonly id: BusId;
  readonly spec: BusSpec;
  readonly effects: EffectUnit[];
  readonly out: Float32Array;
}

interface DuckEntry {
  readonly from: BusRuntime;
  readonly unit: DuckUnit;
}

interface VoiceEntry {
  voice: AudioVoice;
  pcm: VoicePcm;
  bus: BusId;
  plan: VoicePlan;
}

/** 运行期改的静态参数：从 from 线性过渡到 to（不产生折点，只是覆盖同一段） */
interface LiveRamp {
  from: number;
  to: number;
  startMs: Ms;
  rampMs: Ms;
}

function rampAt(ramp: LiveRamp | undefined, ms: Ms, fallback: number): number {
  if (!ramp) return fallback;
  if (ramp.rampMs <= 0) return ramp.to;
  const k = Math.min(1, Math.max(0, (ms - ramp.startMs) / ramp.rampMs));
  return ramp.from + (ramp.to - ramp.from) * k;
}

export class StreamingMixer {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: Ms;
  readonly blockFrames: number;
  private readonly buses: Map<BusId, BusSpec>;
  private readonly order: BusRuntime[];
  private readonly byId: Map<BusId, BusRuntime>;
  private readonly inputs: Map<BusId, Float32Array>;
  private readonly sends: Map<BusId, readonly SendSpec[]>;
  private readonly ducks: Map<BusId, readonly DuckEntry[]>;
  private readonly automation: Map<BusId, (ms: Ms) => BusParams>;
  private readonly soloActive: boolean;
  private readonly voices: VoiceEntry[] = [];
  private readonly liveGain = new Map<BusId, LiveRamp>();
  private readonly livePan = new Map<BusId, LiveRamp>();
  private busOverrides = new Map<
    BusId,
    { gain?: number; pan?: number; mute?: boolean; solo?: boolean }
  >();

  constructor(options: StreamingMixerOptions) {
    this.sampleRate = options.sampleRate;
    this.channels = options.channels;
    this.durationMs = options.durationMs;
    this.blockFrames = Math.max(1, options.blockFrames ?? DEFAULT_BLOCK_FRAMES);
    const bytes = this.blockFrames * this.channels;
    this.buses = new Map<BusId, BusSpec>();
    this.buses.set(MASTER_BUS, { id: MASTER_BUS });
    for (const bus of options.graph.buses) this.buses.set(bus.id, bus);
    const order = topoOrder(
      this.buses,
      options.graph.sends,
      options.graph.ducks,
    );
    this.order = order.map((id) => ({
      id,
      spec: this.buses.get(id)!,
      effects: createEffectUnits(
        this.buses.get(id)!.effects,
        this.sampleRate,
        this.channels,
      ),
      out: new Float32Array(bytes),
    }));
    this.byId = new Map(this.order.map((bus) => [bus.id, bus]));
    this.inputs = new Map(order.map((id) => [id, new Float32Array(bytes)]));
    this.automation = new Map();
    for (const a of options.graph.automation)
      this.automation.set(a.bus, makeAutomation(a));
    this.soloActive = anySolo(options.graph);
    const sends = new Map<BusId, SendSpec[]>();
    for (const s of options.graph.sends) {
      const list = sends.get(s.from);
      if (list) list.push(s);
      else sends.set(s.from, [s]);
    }
    this.sends = sends;
    const ducks = new Map<BusId, DuckEntry[]>();
    for (const rule of options.graph.ducks) {
      const from = this.byId.get(rule.from);
      if (!from) continue;
      const list = ducks.get(rule.to);
      const entry = {
        from,
        unit: new DuckUnit(rule, this.sampleRate, this.channels),
      };
      if (list) list.push(entry);
      else ducks.set(rule.to, [entry]);
    }
    this.ducks = ducks;
  }

  /** 加入一条声音：时间线在加入时求值一次（与整段实现的求值时机相同） */
  addVoice(entry: ProgramVoice): void {
    const bus =
      entry.voice.bus && this.buses.has(entry.voice.bus)
        ? entry.voice.bus
        : MASTER_BUS;
    this.voices.push({
      voice: entry.voice,
      pcm: entry.pcm,
      bus,
      plan: this.planOf(entry.voice, entry.pcm),
    });
  }

  /**
   * 运行期改总线参数（预览端 `setBus` 的落点）。
   * 静态参数被覆盖为「从当前值线性过渡到目标值」，rampMs 为 0 即立即生效；
   * 自动化轨迹仍按帧求值，运行期改动优先于轨迹（与旧预览端 AudioParam 覆盖语义一致）。
   */
  setBusParams(
    id: BusId,
    patch: { gain?: number; pan?: number; mute?: boolean; solo?: boolean },
    atMs: Ms,
    rampMs = 0,
  ): void {
    if (!this.buses.has(id)) return;
    const current = this.busOverrides.get(id) ?? {};
    this.busOverrides.set(id, { ...current, ...patch });
    const params = this.currentParams(id, atMs);
    if (patch.gain !== undefined)
      this.liveGain.set(id, {
        from: params.gain,
        to: Math.max(0, patch.gain),
        startMs: atMs,
        rampMs,
      });
    if (patch.pan !== undefined)
      this.livePan.set(id, {
        from: params.pan,
        to: Math.min(1, Math.max(-1, patch.pan)),
        startMs: atMs,
        rampMs,
      });
  }

  /** 运行期改某个声音的增益：把操作追加进时间线后重新求值（块边界生效） */
  setVoiceGain(id: string, atMs: Ms, value: number, rampMs = 0): void {
    this.appendOp(id, {
      kind: "gain",
      atMs,
      value: Math.max(0, value),
      rampMs: Math.max(0, rampMs),
    });
  }

  /** 运行期改某个声音的速率：同一份重采样逻辑，音高与时长一起变（与导出端一致） */
  setVoiceRate(id: string, atMs: Ms, value: number): void {
    this.appendOp(id, {
      kind: "rate",
      atMs,
      value: Math.max(1e-6, value),
      rampMs: 0,
    });
  }

  /** 运行期停声：追加淡出到 0 的增益操作（导出端语义同此） */
  stopVoice(id: string, atMs: Ms, fadeMs: number): void {
    this.appendOp(id, {
      kind: "stop",
      atMs,
      fadeMs: Math.max(0, fadeMs),
    });
  }

  /** 当前总线静态参数（含运行期覆盖；自动化轨迹在渲染时再叠加） */
  private currentParams(
    id: BusId,
    ms: Ms,
  ): { gain: number; pan: number; mute: boolean; solo: boolean } {
    const spec = this.buses.get(id);
    const patch = this.busOverrides.get(id) ?? {};
    return {
      gain: rampAt(this.liveGain.get(id), ms, patch.gain ?? spec?.gain ?? 1),
      pan: rampAt(this.livePan.get(id), ms, patch.pan ?? spec?.pan ?? 0),
      mute: patch.mute ?? spec?.mute ?? false,
      solo: patch.solo ?? spec?.solo ?? false,
    };
  }

  private planOf(voice: AudioVoice, pcm: VoicePcm): VoicePlan {
    return planVoice(voice, pcm, this.durationMs, this.sampleRate);
  }

  private appendOp(id: string, op: AudioOp): void {
    const entry = this.voices.find((v) => v.voice.id === id);
    if (!entry) return;
    const ops = [...entry.voice.ops, op].sort((a, b) => a.atMs - b.atMs);
    entry.voice = { ...entry.voice, ops };
    entry.plan = this.planOf(entry.voice, entry.pcm);
  }

  /** 渲染一个块：startFrame 是输出网格上的绝对帧号，out 是 frames × channels 交错缓冲 */
  renderBlock(startFrame: number, frames: number, out: Float32Array): void {
    const ch = this.channels;
    const span = frames * ch;
    for (const buf of this.inputs.values()) buf.fill(0, 0, span);
    for (const entry of this.voices) {
      const target = this.inputs.get(entry.bus);
      if (target)
        layVoice(entry.plan, target, startFrame, frames, this.sampleRate, ch);
    }
    for (const bus of this.order) {
      const sig = this.inputs.get(bus.id)!;
      for (const unit of bus.effects) unit.process(sig, frames);
      const target = bus.out;
      target.fill(0, 0, span);
      const auto = this.automation.get(bus.id);
      const spec = bus.spec;
      const patch = this.busOverrides.get(bus.id) ?? {};
      const liveGain = this.liveGain.get(bus.id);
      const livePan = this.livePan.get(bus.id);
      for (let fr = 0; fr < frames; fr++) {
        const ms = ((startFrame + fr) * 1000) / this.sampleRate;
        const p = auto ? auto(ms) : undefined;
        const gain = liveGain
          ? rampAt(liveGain, ms, 1)
          : p
            ? p.gain
            : (patch.gain ?? spec.gain ?? 1);
        const pan = livePan
          ? rampAt(livePan, ms, 0)
          : p
            ? p.pan
            : (patch.pan ?? spec.pan ?? 0);
        const muted = patch.mute ?? (p ? p.mute : (spec.mute ?? false));
        const solo = patch.solo ?? (p ? p.solo : (spec.solo ?? false));
        if (muted || (this.soloActive && !solo && bus.id !== MASTER_BUS))
          continue;
        if (gain <= 0) continue;
        const pl = panGain(pan, 0, ch);
        const pr = panGain(pan, 1, ch);
        for (let c = 0; c < ch; c++) {
          const i = fr * ch + c;
          target[i] = sig[i]! * gain * (c === 0 ? pl : pr);
        }
      }
      for (const duck of this.ducks.get(bus.id) ?? [])
        duck.unit.apply(target, duck.from.out, frames);
      for (const send of this.sends.get(bus.id) ?? []) {
        const dest = this.inputs.get(send.to);
        if (!dest) continue;
        const src = send.pre ? sig : target;
        const amount = Math.max(0, send.amount);
        for (let i = 0; i < span; i++) dest[i]! += src[i]! * amount;
      }
      const parentId = parentOf(this.buses, bus.id);
      const parentInput = parentId ? this.inputs.get(parentId) : undefined;
      if (parentInput)
        for (let i = 0; i < span; i++) parentInput[i]! += target[i]!;
      if (bus.id === MASTER_BUS) out.set(target.subarray(0, span));
    }
  }
}

/** 整段渲染：建一个内核、按块循环写完输出缓冲（导出端与测试用） */
export function mixProgram(input: MixProgramInput): Float32Array {
  const ch = input.channels;
  const frames = Math.max(
    1,
    Math.ceil((input.durationMs / 1000) * input.sampleRate),
  );
  const blockFrames = Math.max(1, input.blockFrames ?? DEFAULT_BLOCK_FRAMES);
  const mixer = new StreamingMixer({ ...input, blockFrames });
  for (const voice of input.voices) mixer.addVoice(voice);
  const out = new Float32Array(frames * ch);
  for (let start = 0; start < frames; start += blockFrames) {
    const n = Math.min(blockFrames, frames - start);
    mixer.renderBlock(start, n, out.subarray(start * ch, (start + n) * ch));
  }
  return out;
}
