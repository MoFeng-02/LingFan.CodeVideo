/** 增益折点构造：基础增益 → 淡入/操作/淡出/envelope → 去重后的线性折线。 */
import type {
  AudioVoice,
  Envelope,
  EnvelopePoint,
  Ms,
} from "@lingfan-video/contracts";
import { clamp } from "./helpers";
import type { GainOp, GainPoint, StopOp } from "./types";

/**
 * 增益折点：起点 → 淡入 → setGain 折线 → 淡出/stop → 终点归零。
 *
 * 折点全部是全局毫秒，增益是线性幅度（基础增益可大于 1，不在此处削波）。
 * 无淡出时不在末尾插归零折点：声音到 endMs 即截断，裁切由渲染端负责。
 * 同一时刻的折点由 `dedupe` 合并（后者覆盖前者），最后按包络相乘（若有）。
 *
 * @param voice 声音实例（引用其中的 gain、ops）
 * @param startMs 声音全局起点（毫秒）
 * @param endLocal 声音局部终点（毫秒，已含全部终界）
 * @param naturalMs 源播完所需的局部毫秒（fadeOut 的起点按声源自然尾对齐；
 *   loop 时自然尾早于 endMs，于是从自然尾一直衰减到 endMs）
 * @returns 增益折点（按 atMs 非递减）
 */
function buildGainPoints(
  voice: AudioVoice,
  startMs: Ms,
  endLocal: Ms,
  naturalMs: Ms,
): GainPoint[] {
  const base = voice.gain.value;
  /** 声音全局终点（毫秒） */
  const endMs = startMs + endLocal;
  const raw: GainPoint[] = [{ atMs: startMs, gain: base }];
  const fadeIn = Math.max(0, voice.gain.fadeIn ?? 0);
  if (fadeIn > 0) {
    raw[0] = { atMs: startMs, gain: 0 };
    raw.push({ atMs: startMs + fadeIn, gain: base });
  }
  /** 运行期音量操作（按生效时刻升序） */
  const gainOps = voice.ops
    .filter((o): o is GainOp => o.kind === "gain")
    .slice()
    .sort((a, b) => a.atMs - b.atMs);
  for (const op of gainOps) {
    /** 生效时刻（钳进可听区间） */
    const at = clamp(op.atMs, startMs, endMs);
    const ramp = Math.max(0, op.rampMs ?? 0);
    if (ramp > 0) {
      raw.push({ atMs: at, gain: sampleRaw(raw, at) });
      raw.push({ atMs: Math.min(at + ramp, endMs), gain: op.value });
    } else raw.push({ atMs: at, gain: op.value });
  }
  const fadeOut = Math.max(0, voice.gain.fadeOut ?? 0);
  /** 最后一次停声操作（以最晚者为准） */
  const stopOp = lastOp(voice, "stop");
  if (stopOp) {
    /** 停声时刻（钳进可听区间） */
    const stopAt = clamp(stopOp.atMs, startMs, endMs);
    const fade = Math.max(0, stopOp.fadeMs ?? 0);
    /** 淡出起点：停声时刻往前 fade 毫秒（不早于声音起点） */
    const from = Math.max(startMs, stopAt - fade);
    raw.push({ atMs: from, gain: sampleRaw(raw, from) });
    raw.push({ atMs: stopAt, gain: 0 });
  } else if (fadeOut > 0) {
    const naturalEnd = startMs + naturalMs;
    const from = Math.max(startMs, Math.min(endMs, naturalEnd) - fadeOut);
    raw.push({ atMs: from, gain: sampleRaw(raw, from) });
    raw.push({ atMs: endMs, gain: 0 });
  }
  // 无淡出时不额外插入归零折点：声音到 endMs 即截断，
  // 预览端的硬切归零由节点终点处理（否则会被误读成「全段线性衰减」）。
  const folded = voice.gain.envelope
    ? applyEnvelope(raw, voice.gain.envelope, startMs, endLocal)
    : raw;
  return dedupe(folded);
}

/**
 * 把包络乘进基础增益折线：在「基础折点 ∪ 包络折点」上取乘积，
 * 于是出片端逐样本与预览端 AudioParam 折线读到的是同一组点（双端同源）。
 *
 * 包络时间以声音局部毫秒为准，`fromEnd` 的折点从声音终点倒算。
 *
 * @param base 基础增益折点（全局毫秒）
 * @param envelope 包络声明（points 为局部毫秒与 0..1 值）
 * @param startMs 声音全局起点（毫秒）
 * @param endLocal 声音局部终点（毫秒）
 * @returns 乘积折线（全局毫秒，按时间递增，未去重）
 */
function applyEnvelope(
  base: readonly GainPoint[],
  envelope: Envelope,
  startMs: Ms,
  endLocal: Ms,
): GainPoint[] {
  /** 参与乘积的时刻集合（基础折点 + 包络折点 + 首尾） */
  const times = new Set<Ms>([startMs, startMs + endLocal]);
  for (const p of base) times.add(p.atMs);
  for (const p of envelope.points)
    times.add(startMs + resolveEnvelopeAt(p, endLocal));
  const out: GainPoint[] = [];
  for (const atMs of [...times].sort((a, b) => a - b)) {
    out.push({
      atMs,
      gain:
        sampleRaw(base, atMs) * envelopeAt(envelope, atMs - startMs, endLocal),
    });
  }
  return out;
}

/**
 * 折点的解析时间（局部毫秒；fromEnd 从声音终点倒算）。
 *
 * @param p 包络折点（atMs 为局部毫秒，fromEnd 时倒算）
 * @param endLocal 声音局部终点（毫秒）
 * @returns 折算后的局部毫秒（钳在 [0, endLocal]）
 */
function resolveEnvelopeAt(p: EnvelopePoint, endLocal: Ms): Ms {
  const t = p.fromEnd ? endLocal - p.atMs : p.atMs;
  return clamp(t, 0, Math.max(0, endLocal));
}

/**
 * 包络在局部毫秒处的取值（首点前取首值、末点后取末值）。
 *
 * 每次调用都重排折点，因此只适合构造期使用；运行期取值走构造好的折线。
 *
 * @param envelope 包络声明
 * @param local 声音内局部毫秒
 * @param endLocal 声音局部终点（毫秒，用于解析 fromEnd）
 * @returns 包络值（0..1 的乘积因子）
 */
function envelopeAt(envelope: Envelope, local: Ms, endLocal: Ms): number {
  const resolved = envelope.points
    .map((p) => ({ atMs: resolveEnvelopeAt(p, endLocal), gain: p.value }))
    .sort((a, b) => a.atMs - b.atMs);
  return sampleLinear(resolved, local);
}

/**
 * 最后一个 stop 操作（先后 stop 以最后一次为准）。
 *
 * @param voice 声音实例
 * @param kind 只接受 "stop"
 * @returns 最晚的停声操作；没有则 null
 */
function lastOp(voice: AudioVoice, kind: "stop"): StopOp | null {
  let out: StopOp | null = null;
  for (const op of voice.ops) {
    if (op.kind !== kind) continue;
    const cur = op as StopOp;
    if (!out || cur.atMs >= out.atMs) out = cur;
  }
  return out;
}

/**
 * 同一时刻（相差 < 1e-9 毫秒）的折点只保留最后一个。
 *
 * @param points 折点表（按 atMs 非递减）
 * @returns 去重后的折点表
 */
function dedupe(points: GainPoint[]): GainPoint[] {
  const out: GainPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.atMs - p.atMs) < 1e-9) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/**
 * 折线取值（超界取端点）。
 *
 * @param points 折线折点（全局毫秒，按时间递增）
 * @param atMs 查询时刻（毫秒）
 * @returns 该时刻的线性插值增益
 */
function sampleRaw(points: readonly GainPoint[], atMs: Ms): number {
  return sampleLinear(points, atMs);
}

/**
 * 折线取值（超界取端点）。
 *
 * @param points 折线折点（按时间递增）
 * @param atMs 查询时刻（毫秒）
 * @returns 该时刻的线性插值增益（空折线为 0）
 */
function sampleLinear(points: readonly GainPoint[], atMs: Ms): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  if (atMs <= first.atMs) return first.gain;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (atMs <= b.atMs) {
      /** 区间长度（非正时直接取右端值） */
      const span = b.atMs - a.atMs;
      if (span <= 0) return b.gain;
      /** 区间内比例（0..1） */
      const k = (atMs - a.atMs) / span;
      return a.gain + (b.gain - a.gain) * k;
    }
  }
  return points[points.length - 1]!.gain;
}

export {
  applyEnvelope,
  buildGainPoints,
  dedupe,
  envelopeAt,
  lastOp,
  resolveEnvelopeAt,
  sampleLinear,
  sampleRaw,
};
