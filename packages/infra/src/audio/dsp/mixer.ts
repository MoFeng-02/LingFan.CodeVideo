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

/**
 * 流式混音器的构造参数。
 *
 * 采样率、声道数、时长与总线拓扑在构造时定死，之后只允许运行期改参数（见 `setBusParams`）；
 * 改这些值必须重建实例。
 */
export interface StreamingMixerOptions {
  /** 输出采样率（Hz，须 > 0）；与源采样率不同时内核逐样本线性插值重采样 */
  readonly sampleRate: number;
  /** 输出声道数（交错缓冲的行宽）；恰为 2 时才做摆位，其余声道数摆位恒 1 */
  readonly channels: number;
  /** 总时间线时长（毫秒）：声音的硬终界，也是循环 `untilMs` 的上界 */
  readonly durationMs: Ms;
  /** 总线拓扑与参数轨迹；父链/发送/侧链成环时构造即抛 name="SpecViolation" */
  readonly graph: AudioGraph;
  /** 块尺寸（帧，缺省 `DEFAULT_BLOCK_FRAMES`，至少 1）；只影响循环次数，不影响逐样本结果 */
  readonly blockFrames?: number;
}

/**
 * 整段渲染的输入：构造参数 + 全部声音。
 *
 * 只用于 `mixProgram`（导出端与测试）；预览端走 `StreamingMixer.addVoice` 逐条投递。
 */
export interface MixProgramInput extends StreamingMixerOptions {
  /** 参与混音的全部声音；顺序不影响结果（各声音独立叠加），后加入的逐样本相加 */
  readonly voices: readonly ProgramVoice[];
}

/** 一条总线的运行期状态：块缓冲与效果链实例（缓冲每块复用，不逐块分配） */
interface BusRuntime {
  /** 总线 id */
  readonly id: BusId;
  /** 总线声明（静态参数与效果链规格） */
  readonly spec: BusSpec;
  /** 效果链实例，按声明顺序串联 */
  readonly effects: EffectUnit[];
  /** 处理后的块输出（长度 = blockFrames × channels） */
  readonly out: Float32Array;
}

/** 挂在目标总线上的侧链压制：来源总线 + 有状态的压制单元 */
interface DuckEntry {
  /** 来源总线（其输出已在本块算好） */
  readonly from: BusRuntime;
  /** 压制单元（包络状态跨块保留） */
  readonly unit: DuckUnit;
}

/** 一条已加入的声音：声明 + PCM + 目标总线 + 求值后的时间线计划 */
interface VoiceEntry {
  voice: AudioVoice;
  pcm: VoicePcm;
  /** 目标总线 id（未登记的总线在加入时退回 master） */
  bus: BusId;
  plan: VoicePlan;
}

/** 运行期改的静态参数：从 from 线性过渡到 to（不产生折点，只是覆盖同一段） */
interface LiveRamp {
  /** 起点值（改动时刻的当前有效值） */
  from: number;
  /** 目标值（增益已钳到 ≥ 0，声像已钳到 -1..1） */
  to: number;
  /** 过渡起点（全局毫秒） */
  startMs: Ms;
  /** 过渡时长（毫秒）；≤ 0 表示立即生效 */
  rampMs: Ms;
}

/**
 * 求运行期过渡在某一时刻的值。
 *
 * @param ramp 过渡；未设置时直接返回 fallback（静态值）
 * @param ms 查询时刻（全局毫秒）
 * @param fallback 未设置过渡时的回退值
 * @returns 该时刻的参数值
 */
function rampAt(ramp: LiveRamp | undefined, ms: Ms, fallback: number): number {
  if (!ramp) return fallback;
  if (ramp.rampMs <= 0) return ramp.to;
  const k = Math.min(1, Math.max(0, (ms - ramp.startMs) / ramp.rampMs));
  return ramp.from + (ramp.to - ramp.from) * k;
}

/**
 * 流式混音器：每次 `renderBlock` 只算给定帧区间，状态跨块保留。
 *
 * 信号路径（逐总线，按拓扑序）：声音铺轨到目标总线输入 → 效果链就地处理 →
 * 逐帧取自动化/运行期覆盖/静态参数 → mute/solo 判定 → pan → 侧链压制 → 发送 → 累加到父总线；
 * 最后 master 的输出写回调用方缓冲。
 *
 * 注意：构造后拓扑与效果链固定；运行期只能改参数与声音操作。多声道（≠ 2）时不做摆位。
 */
export class StreamingMixer {
  /** 输出采样率（Hz） */
  readonly sampleRate: number;
  /** 输出声道数 */
  readonly channels: number;
  /** 总时间线时长（毫秒） */
  readonly durationMs: Ms;
  /** 实际块尺寸（帧，已取 ≥ 1） */
  readonly blockFrames: number;
  private readonly buses: Map<BusId, BusSpec>;
  private readonly order: BusRuntime[];
  private readonly byId: Map<BusId, BusRuntime>;
  /** 每条总线的输入缓冲（本块内先清空，声音与发送叠加到此处） */
  private readonly inputs: Map<BusId, Float32Array>;
  /** 来源总线 → 发送列表 */
  private readonly sends: Map<BusId, readonly SendSpec[]>;
  /** 目标总线 → 侧链压制列表 */
  private readonly ducks: Map<BusId, readonly DuckEntry[]>;
  private readonly automation: Map<BusId, (ms: Ms) => BusParams>;
  /** 是否存在独奏（构造时由静态 solo 与自动化折点决定，运行期不再变化） */
  private readonly soloActive: boolean;
  private readonly voices: VoiceEntry[] = [];
  private readonly liveGain = new Map<BusId, LiveRamp>();
  private readonly livePan = new Map<BusId, LiveRamp>();
  private busOverrides = new Map<
    BusId,
    { gain?: number; pan?: number; mute?: boolean; solo?: boolean }
  >();

  /**
   * @param options 构造参数；采样率/声道数/时长/拓扑在此定死，块尺寸缺省 `DEFAULT_BLOCK_FRAMES`
   */
  constructor(options: StreamingMixerOptions) {
    this.sampleRate = options.sampleRate;
    this.channels = options.channels;
    this.durationMs = options.durationMs;
    this.blockFrames = Math.max(1, options.blockFrames ?? DEFAULT_BLOCK_FRAMES);
    /** 单块样本数（帧 × 声道），所有块缓冲的统一长度 */
    const bytes = this.blockFrames * this.channels;
    this.buses = new Map<BusId, BusSpec>();
    this.buses.set(MASTER_BUS, { id: MASTER_BUS });
    for (const bus of options.graph.buses) this.buses.set(bus.id, bus);
    /** 处理顺序：来源（父总线/发送源/侧链源）总在目标之前 */
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
    /** 来源总线 → 它的发送列表 */
    const sends = new Map<BusId, SendSpec[]>();
    for (const s of options.graph.sends) {
      const list = sends.get(s.from);
      if (list) list.push(s);
      else sends.set(s.from, [s]);
    }
    this.sends = sends;
    /** 目标总线 → 它的压制列表（来源未登记则跳过该规则） */
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

  /**
   * 加入一条声音：时间线在加入时求值一次（与整段实现的求值时机相同）。
   *
   * 之后对该声音的运行期操作（改增益/速率/停声）都会重新求值计划；块边界生效。
   *
   * @param entry 声音声明 + 已解码 PCM
   */
  addVoice(entry: ProgramVoice): void {
    /** 目标总线：未登记的名字退回 master */
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
   *
   * 静态参数被覆盖为「从当前值线性过渡到目标值」，rampMs 为 0 即立即生效；
   * 增益钳到 ≥ 0、声像钳到 -1..1。求值优先级：运行期过渡 > 自动化轨迹 > 静态值；
   * mute/solo 的运行期覆盖优先于自动化与静态值。
   * 注意独奏判定在构造时定死：运行期把 solo 置真不会让其它总线静音，只影响本总线自身。
   *
   * @param id 总线 id；未登记时忽略
   * @param patch 要改的字段（未给出的字段保持原样）
   * @param atMs 改动起点（全局毫秒）
   * @param rampMs 过渡时长（毫秒，缺省 0 = 立即）
   */
  setBusParams(
    id: BusId,
    patch: { gain?: number; pan?: number; mute?: boolean; solo?: boolean },
    atMs: Ms,
    rampMs = 0,
  ): void {
    if (!this.buses.has(id)) return;
    /** 已有覆盖（合并后仍保留未给出的字段） */
    const current = this.busOverrides.get(id) ?? {};
    this.busOverrides.set(id, { ...current, ...patch });
    /** 过渡起点（当前有效值，含未完成的过渡） */
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

  /**
   * 运行期改某个声音的增益：把操作追加进时间线后重新求值（块边界生效）。
   *
   * @param id 声音 id；未加入时忽略
   * @param atMs 操作时刻（全局毫秒）
   * @param value 目标增益（线性，钳到 ≥ 0）
   * @param rampMs 过渡时长（毫秒，缺省 0 = 立即）
   */
  setVoiceGain(id: string, atMs: Ms, value: number, rampMs = 0): void {
    this.appendOp(id, {
      kind: "gain",
      atMs,
      value: Math.max(0, value),
      rampMs: Math.max(0, rampMs),
    });
  }

  /**
   * 运行期改某个声音的速率：同一份重采样逻辑，音高与时长一起变（与导出端一致）。
   *
   * @param id 声音 id；未加入时忽略
   * @param atMs 操作时刻（全局毫秒）
   * @param value 速率/音高倍率（> 0，钳到 ≥ 1e-6；不支持倒放）
   * @param rampMs 过渡时长（毫秒，钳到 ≥ 0；期间速率从当前值线性爬到目标值）
   */
  setVoiceRate(id: string, atMs: Ms, value: number, rampMs = 0): void {
    this.appendOp(id, {
      kind: "rate",
      atMs,
      value: Math.max(1e-6, value),
      rampMs: Math.max(0, rampMs),
    });
  }

  /**
   * 运行期停声：追加淡出到 0 的增益操作（导出端语义同此）。
   *
   * @param id 声音 id；未加入时忽略
   * @param atMs 停声时刻（全局毫秒）
   * @param fadeMs 淡出时长（毫秒，钳到 ≥ 0；0 为硬切）
   */
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
    /** 静态声明（覆盖与轨迹的回退值） */
    const spec = this.buses.get(id);
    /** 运行期覆盖（优先于静态声明） */
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

  /** 追加一条运行期操作：按时刻重排后重新求值时间线（操作列表只增不删） */
  private appendOp(id: string, op: AudioOp): void {
    /** 目标声音（未加入则忽略该操作） */
    const entry = this.voices.find((v) => v.voice.id === id);
    if (!entry) return;
    /** 追加后按时刻稳定重排（时间线求值按序消费） */
    const ops = [...entry.voice.ops, op].sort((a, b) => a.atMs - b.atMs);
    entry.voice = { ...entry.voice, ops };
    entry.plan = this.planOf(entry.voice, entry.pcm);
  }

  /**
   * 渲染一个块：startFrame 是输出网格上的绝对帧号，out 是 frames × channels 交错缓冲。
   *
   * 只写 out 的前 frames × channels 个样本（更长的尾部保持原值）；块与块之间没有重叠，
   * 因此分块大小不影响结果。块尺寸与 `frames` 可以不同：本方法按调用方给的帧数工作。
   *
   * @param startFrame 本块第一帧在输出网格上的帧号（≥ 0）
   * @param frames 本块帧数（≥ 1；通常等于 blockFrames）
   * @param out 交错输出缓冲（长度 ≥ frames × channels）
   */
  renderBlock(startFrame: number, frames: number, out: Float32Array): void {
    const ch = this.channels;
    /** 本块样本数（帧 × 声道） */
    const span = frames * ch;
    for (const buf of this.inputs.values()) buf.fill(0, 0, span);
    for (const entry of this.voices) {
      /** 该声音目标总线的输入缓冲（声音先叠到总线输入，再进效果链） */
      const target = this.inputs.get(entry.bus);
      if (target)
        layVoice(entry.plan, target, startFrame, frames, this.sampleRate, ch);
    }
    for (const bus of this.order) {
      /** 本总线输入：效果链就地处理 */
      const sig = this.inputs.get(bus.id)!;
      for (const unit of bus.effects) unit.process(sig, frames);
      /** 总线输出缓冲（先清零，再逐帧写入；被静音时保持全零） */
      const target = bus.out;
      target.fill(0, 0, span);
      const auto = this.automation.get(bus.id);
      const spec = bus.spec;
      const patch = this.busOverrides.get(bus.id) ?? {};
      const liveGain = this.liveGain.get(bus.id);
      const livePan = this.livePan.get(bus.id);
      for (let fr = 0; fr < frames; fr++) {
        const ms = ((startFrame + fr) * 1000) / this.sampleRate;
        /** 该帧的自动化参数（无轨迹时为 undefined） */
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
        /** 该帧是否独奏（独奏集合为空时不影响任何总线） */
        const solo = patch.solo ?? (p ? p.solo : (spec.solo ?? false));
        if (muted || (this.soloActive && !solo && bus.id !== MASTER_BUS))
          continue;
        if (gain <= 0) continue;
        /** 左右声道的摆位乘子（非立体声输出时都为 1） */
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
        /** 发送目标总线的输入缓冲（发送是叠加，不是覆盖） */
        const dest = this.inputs.get(send.to);
        if (!dest) continue;
        /** 发送取信号的位置：pre = 效果前，否则推子后（pan/duck 之后） */
        const src = send.pre ? sig : target;
        /** 发送量（线性，负值按 0） */
        const amount = Math.max(0, send.amount);
        for (let i = 0; i < span; i++) dest[i]! += src[i]! * amount;
      }
      const parentId = parentOf(this.buses, bus.id);
      /** 父总线输入（输出同时累加给父，形成总线树） */
      const parentInput = parentId ? this.inputs.get(parentId) : undefined;
      if (parentInput)
        for (let i = 0; i < span; i++) parentInput[i]! += target[i]!;
      if (bus.id === MASTER_BUS) out.set(target.subarray(0, span));
    }
  }
}

/**
 * 整段渲染：建一个内核、按块循环写完输出缓冲（导出端与测试用）。
 *
 * 输出帧数 = ceil(durationMs / 1000 × sampleRate)（至少 1 帧），布局为交错立体声/多声道；
 * 与预览端逐块渲染共用同一内核，因此两端结果逐样本一致。
 *
 * @param input 构造参数 + 全部声音
 * @returns 交错样本（长度 = 帧数 × 声道数）
 */
export function mixProgram(input: MixProgramInput): Float32Array {
  const ch = input.channels;
  /** 输出总帧数（至少 1 帧） */
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
