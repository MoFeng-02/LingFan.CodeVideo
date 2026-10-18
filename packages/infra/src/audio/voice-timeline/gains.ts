/** 增益折点构造：基础增益 → 淡入/操作/淡出/envelope → 去重后的线性折线。 */
import type {
  AudioVoice,
  Envelope,
  EnvelopePoint,
  Ms,
} from "@lingfan-video/contracts";
import { clamp } from "./helpers";
import type { GainOp, GainPoint, StopOp } from "./types";

/** 增益折点：起点 → 淡入 → setGain 折线 → 淡出/stop → 终点归零 */
function buildGainPoints(
  voice: AudioVoice,
  startMs: Ms,
  endLocal: Ms,
  naturalMs: Ms,
): GainPoint[] {
  const base = voice.gain.value;
  const endMs = startMs + endLocal;
  const raw: GainPoint[] = [{ atMs: startMs, gain: base }];
  const fadeIn = Math.max(0, voice.gain.fadeIn ?? 0);
  if (fadeIn > 0) {
    raw[0] = { atMs: startMs, gain: 0 };
    raw.push({ atMs: startMs + fadeIn, gain: base });
  }
  const gainOps = voice.ops
    .filter((o): o is GainOp => o.kind === "gain")
    .slice()
    .sort((a, b) => a.atMs - b.atMs);
  for (const op of gainOps) {
    const at = clamp(op.atMs, startMs, endMs);
    const ramp = Math.max(0, op.rampMs ?? 0);
    if (ramp > 0) {
      raw.push({ atMs: at, gain: sampleRaw(raw, at) });
      raw.push({ atMs: Math.min(at + ramp, endMs), gain: op.value });
    } else raw.push({ atMs: at, gain: op.value });
  }
  const fadeOut = Math.max(0, voice.gain.fadeOut ?? 0);
  const stopOp = lastOp(voice, "stop");
  if (stopOp) {
    const stopAt = clamp(stopOp.atMs, startMs, endMs);
    const fade = Math.max(0, stopOp.fadeMs ?? 0);
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
 * 于是导出逐样本与预览 AudioParam 折线读到的是同一组点（双端同源）。
 */
function applyEnvelope(
  base: readonly GainPoint[],
  envelope: Envelope,
  startMs: Ms,
  endLocal: Ms,
): GainPoint[] {
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

/** 折点的解析时间（局部毫秒；fromEnd 从声音终点倒算） */
function resolveEnvelopeAt(p: EnvelopePoint, endLocal: Ms): Ms {
  const t = p.fromEnd ? endLocal - p.atMs : p.atMs;
  return clamp(t, 0, Math.max(0, endLocal));
}

/** 包络在局部毫秒处的取值（首点前取首值、末点后取末值） */
function envelopeAt(envelope: Envelope, local: Ms, endLocal: Ms): number {
  const resolved = envelope.points
    .map((p) => ({ atMs: resolveEnvelopeAt(p, endLocal), gain: p.value }))
    .sort((a, b) => a.atMs - b.atMs);
  return sampleLinear(resolved, local, Number.POSITIVE_INFINITY);
}

/** 最后一个 stop 操作（先后 stop 以最后一次为准） */
function lastOp(voice: AudioVoice, kind: "stop"): StopOp | null {
  let out: StopOp | null = null;
  for (const op of voice.ops) {
    if (op.kind !== kind) continue;
    const cur = op as StopOp;
    if (!out || cur.atMs >= out.atMs) out = cur;
  }
  return out;
}

function dedupe(points: GainPoint[]): GainPoint[] {
  const out: GainPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.atMs - p.atMs) < 1e-9) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function sampleRaw(points: readonly GainPoint[], atMs: Ms): number {
  return sampleLinear(points, atMs, Number.POSITIVE_INFINITY);
}

/** 折线取值（超界取端点） */
function sampleLinear(
  points: readonly GainPoint[],
  atMs: Ms,
  _endMs: Ms,
): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  if (atMs <= first.atMs) return first.gain;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (atMs <= b.atMs) {
      const span = b.atMs - a.atMs;
      if (span <= 0) return b.gain;
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
