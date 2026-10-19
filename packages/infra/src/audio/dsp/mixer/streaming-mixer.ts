/**
 * 单一混音内核：块处理的流式混音器。
 *
 * 导出端（Node/浏览器离线）按块循环渲染整段；预览端把同一个类放进 AudioWorklet，
 * 由音频线程逐块驱动。两条路径共用同一份状态与运算，因此两端音色同源；
 * 块尺寸只影响循环次数，不影响逐样本结果。
 */
import type {
  AudioOp,
  AudioVoice,
  BusId,
  BusSpec,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import { DuckUnit } from "../duck";
import { createEffectUnits } from "../effects";
import { makeAutomation, parentOf, topoOrder, type BusParams } from "../graph";
import { panGain } from "../math";
import type { ProgramVoice, VoicePcm } from "../types";
import { layVoice, planVoice, type VoicePlan } from "../voice";
import { blockParamsOf, rampAt, soloFlagsOf } from "./bus-params";
import {
  DEFAULT_BLOCK_FRAMES,
  type BusParamsPatch,
  type BusRuntime,
  type DuckEntry,
  type LiveRamp,
  type SendTable,
  type StreamingMixerOptions,
  type VoiceEntry,
} from "./types";

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
  private readonly sends: SendTable;
  /** 目标总线 → 侧链压制列表 */
  private readonly ducks: Map<BusId, readonly DuckEntry[]>;
  private readonly automation: Map<BusId, (ms: Ms) => BusParams>;
  private readonly voices: VoiceEntry[] = [];
  private readonly liveGain = new Map<BusId, LiveRamp>();
  private readonly livePan = new Map<BusId, LiveRamp>();
  private busOverrides = new Map<BusId, BusParamsPatch>();

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
   * mute/solo 的运行期覆盖优先于自动化与静态值。独奏按帧判定：任一条非 master 总线
   * 处于独奏（静态声明、运行期覆盖或自动化折点）时，其余非 master 总线整块静音。
   *
   * @param id 总线 id；未登记时忽略
   * @param patch 要改的字段（未给出的字段保持原样）
   * @param atMs 改动起点（全局毫秒）
   * @param rampMs 过渡时长（毫秒，缺省 0 = 立即）
   */
  setBusParams(id: BusId, patch: BusParamsPatch, atMs: Ms, rampMs = 0): void {
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
    /** 本块逐帧自动化参数：每条总线只求值一次（查询游标只前进），主循环与独奏判定共用 */
    const blockParams = blockParamsOf(
      this.order,
      this.automation,
      startFrame,
      frames,
      this.sampleRate,
    );
    /** 逐帧是否存在独奏：静态声明、运行期覆盖与自动化折点都算，逐帧变化 */
    const soloFlags = soloFlagsOf(
      this.order,
      blockParams,
      this.busOverrides,
      frames,
    );
    for (const bus of this.order) {
      /** 本总线输入：效果链就地处理 */
      const sig = this.inputs.get(bus.id)!;
      for (const unit of bus.effects) unit.process(sig, frames);
      /** 总线输出缓冲（先清零，再逐帧写入；被静音时保持全零） */
      const target = bus.out;
      target.fill(0, 0, span);
      const auto = blockParams.get(bus.id);
      const spec = bus.spec;
      const patch = this.busOverrides.get(bus.id) ?? {};
      const liveGain = this.liveGain.get(bus.id);
      const livePan = this.livePan.get(bus.id);
      for (let fr = 0; fr < frames; fr++) {
        const ms = ((startFrame + fr) * 1000) / this.sampleRate;
        const gain = liveGain
          ? rampAt(liveGain, ms, 1)
          : auto
            ? auto.gain[fr]!
            : (patch.gain ?? spec.gain ?? 1);
        const pan = livePan
          ? rampAt(livePan, ms, 0)
          : auto
            ? auto.pan[fr]!
            : (patch.pan ?? spec.pan ?? 0);
        const muted =
          patch.mute ?? (auto ? auto.mute[fr] === 1 : (spec.mute ?? false));
        /** 该帧是否独奏（逐帧判定：运行期 solo 同样压制未独奏总线） */
        const solo =
          patch.solo ?? (auto ? auto.solo[fr] === 1 : (spec.solo ?? false));
        if (muted || (soloFlags[fr] === 1 && !solo && bus.id !== MASTER_BUS))
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
