/**
 * 总线图混音：把「声音 + 音频图」变成一路交错输出。
 * 确定性：同一 program 必同样本——所有 DSP 都是逐样本、无随机、无墙钟。
 * 顺序即语义：拓扑排序（子 → 父、发送源 → 目标、侧链源 → 目标），
 * 每个总线先过效果、再过参数自动化/独奏静音/侧链压制，最后按发送汇入目标。
 */
import type {
  AudioGraph,
  DelaySpec,
  ReverbSpec,
  AudioVoice,
  BusAutomation,
  BusId,
  BusSpec,
  CompressorSpec,
  DuckRule,
  FilterSpec,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";

export interface BusMixInput {
  sampleRate: number;
  channels: number;
  frames: number;
  durationMs: Ms;
  voices: readonly AudioVoice[];
  graph: AudioGraph;
  /** 单声音铺轨（由混音器提供：时间映射/包络/pan 已实现，写入目标交错缓冲） */
  layoutVoice: (
    voice: AudioVoice,
    target: Float32Array,
    outFrames: number,
    durationMs: Ms,
  ) => void;
}

const SILENT = 1e-9;

export function mixBusGraph(input: BusMixInput): Float32Array {
  const { sampleRate: sr, channels: ch, frames, graph } = input;
  const buses = new Map<BusId, BusSpec>();
  buses.set(MASTER_BUS, { id: MASTER_BUS });
  for (const b of graph.buses) buses.set(b.id, b);
  const order = topoOrder(buses, graph.sends, graph.ducks);

  const input_ = new Map<BusId, Float32Array>();
  for (const id of buses.keys()) input_.set(id, new Float32Array(frames * ch));
  for (const voice of input.voices) {
    const targetId = voice.bus && buses.has(voice.bus) ? voice.bus : MASTER_BUS;
    const target = input_.get(targetId)!;
    input.layoutVoice(voice, target, frames, input.durationMs);
  }

  const automation = new Map<BusId, (ms: Ms) => BusParams>();
  for (const a of graph.automation) automation.set(a.bus, makeAutomation(a));
  const staticParams = (id: BusId): BusParams => {
    const spec = buses.get(id);
    return {
      gain: spec?.gain ?? 1,
      pan: spec?.pan ?? 0,
      mute: spec?.mute ?? false,
      solo: spec?.solo ?? false,
    };
  };
  // 独奏：任一条非 master 总线在任一时刻 solo → 未 solo 的总线静音
  const soloActive = anySolo(graph);

  const outputs = new Map<BusId, Float32Array>();
  const duckGains = new Map<string, Float32Array>();
  for (const id of order) {
    const spec = buses.get(id);
    if (!spec) continue;
    let sig = input_.get(id)!;
    // 效果（就地；顺序 = 声明顺序）
    for (const eff of spec.effects ?? []) {
      if (eff.kind === "filter") filterInPlace(sig, eff, sr, ch);
      else if (eff.kind === "compressor") compressorInPlace(sig, eff, sr, ch);
      else if (eff.kind === "delay") delayInPlace(sig, eff, sr, ch);
      else reverbInPlace(sig, eff, sr, ch);
    }
    const out = new Float32Array(frames * ch);
    const auto = automation.get(id);
    const base = staticParams(id);
    const pan = auto ? (ms: Ms) => auto(ms).pan : () => base.pan;
    const gainOf = auto ? (ms: Ms) => auto(ms).gain : () => base.gain;
    const muteOf = auto ? (ms: Ms) => auto(ms).mute : () => base.mute;
    const soloOf = auto ? (ms: Ms) => auto(ms).solo : () => base.solo;
    for (let fr = 0; fr < frames; fr++) {
      const ms = (fr * 1000) / sr;
      const muted =
        muteOf(ms) || (soloActive && !soloOf(ms) && id !== MASTER_BUS);
      if (muted) continue;
      const g = gainOf(ms);
      if (g <= 0) continue;
      const pl = panGain(pan(ms), 0, ch);
      const pr = panGain(pan(ms), 1, ch);
      for (let c = 0; c < ch; c++) {
        out[fr * ch + c] = sig[fr * ch + c]! * g * (c === 0 ? pl : pr);
      }
    }
    // 侧链压制：来源总线必须先算出输出（拓扑序保证）
    for (const rule of graph.ducks.filter((d) => d.to === id)) {
      const from = outputs.get(rule.from);
      if (!from) continue; // 来源不可用（可能被静音整个跳过）→ 不压制
      const key = `${rule.from}->${rule.to}`;
      let reduction = duckGains.get(key);
      if (!reduction) {
        reduction = computeDuckGain(from, rule, sr, ch, frames);
        duckGains.set(key, reduction);
      }
      for (let i = 0; i < out.length; i++)
        out[i]! *= reduction[Math.floor(i / ch)]!;
    }
    // 发送（post-fader；pre 取效果前信号）
    for (const send of graph.sends.filter((s) => s.from === id)) {
      const target = input_.get(send.to);
      if (!target) continue;
      const src = send.pre ? input_.get(id)! : out;
      const amount = Math.max(0, send.amount);
      for (let i = 0; i < src.length; i++) target[i]! += src[i]! * amount;
    }
    outputs.set(id, out);
    // 汇入父总线（拓扑序保证父总线尚未处理）
    const parentId = parentOfOf(buses, id);
    const parentInput = parentId ? input_.get(parentId) : undefined;
    if (parentInput) {
      for (let i = 0; i < out.length; i++) parentInput[i]! += out[i]!;
    }
  }
  return outputs.get(MASTER_BUS) ?? new Float32Array(frames * ch);
}

interface BusParams {
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

function makeAutomation(a: BusAutomation): (ms: Ms) => BusParams {
  const pts = a.points;
  if (pts.length === 0)
    return () => ({ gain: 1, pan: 0, mute: false, solo: false });
  let idx = 0;
  return (ms: Ms) => {
    while (idx + 1 < pts.length && pts[idx + 1]!.atMs <= ms) idx++;
    const p0 = pts[idx]!;
    const p1 = idx + 1 < pts.length ? pts[idx + 1]! : undefined;
    if (!p1 || p1.atMs === p0.atMs || ms <= p0.atMs) return p0;
    const k = Math.min(1, Math.max(0, (ms - p0.atMs) / (p1.atMs - p0.atMs)));
    return {
      gain: p0.gain + (p1.gain - p0.gain) * k,
      pan: p0.pan + (p1.pan - p0.pan) * k,
      mute: k < 1 ? p0.mute : p1.mute,
      solo: k < 1 ? p0.solo : p1.solo,
    };
  };
}

function anySolo(graph: AudioGraph): boolean {
  if (graph.buses.some((b) => b.solo && b.id !== MASTER_BUS)) return true;
  return graph.automation.some(
    (a) => a.bus !== MASTER_BUS && a.points.some((p) => p.solo),
  );
}

/** 拓扑排序：子→父、send.from→send.to、duck.from→duck.to；成环即错 */
function topoOrder(
  buses: Map<BusId, BusSpec>,
  sends: readonly SendSpec[],
  ducks: readonly DuckRule[],
): BusId[] {
  const indeg = new Map<BusId, number>();
  const edges = new Map<BusId, Set<BusId>>();
  for (const id of buses.keys()) {
    indeg.set(id, 0);
    edges.set(id, new Set());
  }
  const addEdge = (from: BusId, to: BusId): void => {
    if (!buses.has(from) || !buses.has(to) || from === to) return;
    const set = edges.get(from)!;
    if (set.has(to)) return;
    set.add(to);
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
  };
  for (const id of buses.keys()) {
    const p =
      id === MASTER_BUS ? undefined : (parentOfOf(buses, id) ?? MASTER_BUS);
    if (p) addEdge(id, p);
  }
  for (const s of sends) addEdge(s.from, s.to);
  for (const d of ducks) addEdge(d.from, d.to);
  const queue: BusId[] = [];
  for (const [id, n] of indeg) if (n === 0) queue.push(id);
  const out: BusId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of edges.get(id) ?? []) {
      const n = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (out.length !== buses.size)
    throw Object.assign(
      new Error("spec_violation: 音频总线图成环（父链/发送/侧链构成循环）"),
      { name: "SpecViolation" },
    );
  return out;
}

function parentOfOf(buses: Map<BusId, BusSpec>, id: BusId): BusId | undefined {
  if (id === MASTER_BUS) return undefined;
  const p = buses.get(id)?.parent;
  return p && buses.has(p) && p !== id ? p : MASTER_BUS;
}

/** 侧链压制增益（每帧一个乘子）：来源输出包络 → 超阈值按 amountDb 压低，attack/hold/release 平滑 */
function computeDuckGain(
  from: Float32Array,
  rule: DuckRule,
  sr: number,
  ch: number,
  frames: number,
): Float32Array {
  const attack = onePole(rule.attackMs ?? 10, sr);
  const release = onePole(rule.releaseMs ?? 200, sr);
  const holdSamples = Math.max(0, Math.round(((rule.holdMs ?? 0) / 1000) * sr));
  const threshold = rule.thresholdDb ?? -30;
  const out = new Float32Array(frames);
  let env = 0;
  let cur = 0; // 当前压制量（dB）
  let hold = 0;
  for (let fr = 0; fr < frames; fr++) {
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const v = Math.abs(from[fr * ch + c] ?? 0);
      if (v > peak) peak = v;
    }
    const coef = peak > env ? attack : release;
    env = coef * env + (1 - coef) * peak;
    const db = 20 * Math.log10(Math.max(env, SILENT));
    const active = db > threshold;
    let target = active
      ? rule.amountDb * Math.min(1, (db - threshold) / 12)
      : 0;
    if (active) hold = holdSamples;
    else if (hold > 0) {
      hold--;
      target = cur; // 保持期：维持当前压制量
    }
    const coeff = target > cur ? attack : release;
    cur = coeff * cur + (1 - coeff) * target;
    out[fr] = 10 ** (-cur / 20);
  }
  return out;
}

function onePole(ms: Ms, sr: number): number {
  if (ms <= 0) return 0;
  return Math.exp((-1000 / ms) * (1 / sr));
}

/** biquad 滤波（RBJ cookbook；就地处理） */
function filterInPlace(
  buf: Float32Array,
  spec: FilterSpec,
  sr: number,
  ch: number,
): void {
  const f = Math.max(10, Math.min(sr / 2 - 1, spec.frequency));
  const q = spec.q ?? Math.SQRT1_2;
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (spec.type === "lowpass") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (spec.type === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;
  for (let c = 0; c < ch; c++) {
    let z1 = 0;
    let z2 = 0;
    for (let fr = 0; fr < buf.length / ch; fr++) {
      const i = fr * ch + c;
      const x = buf[i]!;
      const y = nb0 * x + z1;
      z1 = nb1 * x - na1 * y + z2;
      z2 = nb2 * x - na2 * y;
      buf[i] = y;
    }
  }
}

/** 压缩器（就地；峰值检测 + 硬拐点）；env 平滑后直接换算增益 */
function compressorInPlace(
  buf: Float32Array,
  spec: CompressorSpec,
  sr: number,
  ch: number,
): void {
  const attack = onePole(spec.attackMs, sr);
  const release = onePole(spec.releaseMs, sr);
  const ratio = Math.max(1, spec.ratio);
  let env = 0;
  let reduction = 0;
  for (let fr = 0; fr < buf.length / ch; fr++) {
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const v = Math.abs(buf[fr * ch + c] ?? 0);
      if (v > peak) peak = v;
    }
    const coef = peak > env ? attack : release;
    env = coef * env + (1 - coef) * peak;
    const db = 20 * Math.log10(Math.max(env, SILENT));
    const over = db - spec.thresholdDb;
    const target = over > 0 ? -(over * (1 - 1 / ratio)) : 0;
    const smooth = target < reduction ? attack : release;
    reduction = smooth * reduction + (1 - smooth) * target;
    const g = 10 ** (reduction / 20);
    if (g === 1) continue;
    for (let c = 0; c < ch; c++) {
      const i = fr * ch + c;
      buf[i] = buf[i]! * g;
    }
  }
}

/** 摆位增益（与声音级同一近似：线性律） */
function panGain(pan: number, ch: number, outCh: number): number {
  if (outCh < 2) return 1;
  const p = Math.max(-1, Math.min(1, pan));
  return ch === 0 ? 1 - Math.max(0, p) : 1 - Math.max(0, -p);
}

/** 延迟线（确定性）：环形缓冲 + 反馈，干湿混合 */
function delayInPlace(
  buf: Float32Array,
  spec: DelaySpec,
  sr: number,
  ch: number,
): void {
  const d = Math.max(1, Math.round((spec.delayMs * sr) / 1000));
  const fb = Math.max(0, Math.min(0.95, spec.feedback ?? 0.3));
  const mix = Math.max(0, Math.min(1, spec.mix ?? 0.5));
  const line = new Float32Array(d);
  const frames = Math.floor(buf.length / ch);
  let idx = 0;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const i = f * ch + c;
      const dry = buf[i]!;
      const wet = line[idx]!;
      line[idx] = dry + wet * fb;
      buf[i] = dry * (1 - mix) + wet * mix;
    }
    idx = (idx + 1) % d;
  }
}

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

/**
 * 简化 Freeverb（确定性）：8 comb 并联 + 4 allpass 串联，按 44.1k 基准调谐缩放。
 * 与预览端 ConvolverNode 的 IR 卷积不是同一算法：音色近似，时序一致。
 */
function reverbInPlace(
  buf: Float32Array,
  spec: ReverbSpec,
  sr: number,
  ch: number,
): void {
  const scale = sr / 44100;
  const room = Math.max(0, Math.min(1, spec.roomSize ?? 0.7));
  const damp = Math.max(0, Math.min(1, spec.damping ?? 0.4));
  const mix = Math.max(0, Math.min(1, spec.mix ?? 0.35));
  const feedback = room * 0.28 + 0.7;
  const damp1 = damp * 0.4;
  const damp2 = 1 - damp1;
  const frames = Math.floor(buf.length / ch);
  for (let c = 0; c < ch; c++) {
    const spread = c * STEREO_SPREAD;
    const combs = COMB_TUNING.map((t) => ({
      buf: new Float32Array(Math.max(1, Math.round((t + spread) * scale))),
      idx: 0,
      store: 0,
    }));
    const aps = ALLPASS_TUNING.map((t) => ({
      buf: new Float32Array(Math.max(1, Math.round((t + spread) * scale))),
      idx: 0,
    }));
    for (let f = 0; f < frames; f++) {
      const i = f * ch + c;
      const dry = buf[i]!;
      const input = dry * 0.015;
      let out = 0;
      for (const cb of combs) {
        const y = cb.buf[cb.idx]!;
        cb.store = y * damp2 + cb.store * damp1;
        cb.buf[cb.idx] = input + cb.store * feedback;
        cb.idx = (cb.idx + 1) % cb.buf.length;
        out += y;
      }
      for (const ap of aps) {
        const b = ap.buf[ap.idx]!;
        const y = -out + b;
        ap.buf[ap.idx] = out + b * 0.5;
        ap.idx = (ap.idx + 1) % ap.buf.length;
        out = y;
      }
      buf[i] = dry * (1 - mix) + out * mix;
    }
  }
}
