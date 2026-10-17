/**
 * 声音求值（voice → 可执行时间线）：**唯一求值点**。
 *
 * 导出端逐样本取源、预览端生成 AudioParam 自动化、以及「声音何时自然结束」
 * 全部由本模块给出——两端不允许各自推导，否则预览与导出必然漂移。
 *
 * 时间轴定义：voice.startMs 为全局起点；local = 全局毫秒 - startMs。
 * 源位置 = 速率对时间线积分 M(local) = ∫₀^local rate dt：
 *  - 基础段来自 rate（恒速或 warp 锚点斜率）；
 *  - 运行期 setRate 在调用时刻切分，先线性爬坡再常量（覆盖其后）；
 *  - loop 时源位置取 M(local) 对源时长的余数（源空间回卷）。
 */
import type {
  AudioRate,
  AudioVoice,
  Envelope,
  EnvelopePoint,
  Ms,
  WarpPoint,
} from "@lingfan-video/contracts";
import { resolveWarp } from "./warp";

/** 速率分段：段内速率由 fromRate 线性变到 toRate（相等即常量段） */
interface RatePiece {
  readonly fromMs: Ms;
  readonly toMs: Ms;
  readonly fromRate: number;
  readonly toRate: number;
  /** 段起点对应的源内毫秒 */
  readonly sourceFrom: Ms;
}

/** 增益折点（全局毫秒），段内线性——预览端直接当 AudioParam 自动化用 */
export interface GainPoint {
  readonly atMs: Ms;
  readonly gain: number;
}

/** 一个声音的可执行时间线（导出与预览共用） */
export interface VoiceTimeline {
  /** 全局起点（毫秒） */
  readonly startMs: Ms;
  /** 全局终点（毫秒；已按源播完/stop/until/总时间线尾裁定） */
  readonly endMs: Ms;
  readonly loop: boolean;
  readonly pan: number;
  /** 全局毫秒 → 源内毫秒（已按 loop 回卷；越界裁到源内） */
  sourceMsAt(globalMs: Ms): Ms;
  /** 全局毫秒处的瞬时速率（音高倍率） */
  rateAt(globalMs: Ms): number;
  /** 全局毫秒处的线性增益（0..N，含淡入淡出、setGain、stop 淡出） */
  gainAt(globalMs: Ms): number;
  readonly gainPoints: readonly GainPoint[];
}

/** 求值：voice + 源时长 + 总时间线终点 → 可执行时间线 */
export function evaluateVoice(
  voice: AudioVoice,
  sourceDurationMs: Ms,
  timelineEndMs: Ms,
): VoiceTimeline {
  const startMs = voice.startMs;
  const pieces = applyOps(buildBasePieces(voice.rate, sourceDurationMs), voice);
  const integral = makeIntegral(pieces);
  const loop = voice.loop !== null;
  const srcDur = Math.max(0, sourceDurationMs);

  // 自然收尾 / 循环时长：源被放完所需的局部时间（速率可变，故用逆积分）
  const naturalMs = srcDur > 0 ? integral.inverse(srcDur) : 0;
  const stopOp = lastOp(voice, "stop");
  const stopMs = stopOp ? Math.max(0, stopOp.atMs - startMs) : Infinity;
  const untilMs = voice.loop?.untilMs;
  const untilLocal = untilMs === undefined ? Infinity : Math.max(0, untilMs);

  // 终界规则：总时间线尾是唯一硬界；再看 stop / until / 源播完
  const hardEnd = Math.max(0, timelineEndMs - startMs);
  let endLocal = Math.min(hardEnd, stopMs);
  if (loop) endLocal = Math.min(endLocal, untilLocal);
  else endLocal = Math.min(endLocal, naturalMs);
  if (endLocal < 0) endLocal = 0;

  const gainPoints = buildGainPoints(voice, startMs, endLocal, naturalMs);
  const gainAt = (globalMs: Ms): number =>
    sampleLinear(gainPoints, globalMs, endMsOf(startMs, endLocal));

  return {
    startMs,
    endMs: startMs + endLocal,
    loop,
    pan: voice.pan.value,
    sourceMsAt: (globalMs: Ms): Ms => {
      const local = clamp(globalMs - startMs, 0, endLocal);
      const pos = integral.at(local);
      if (!loop || srcDur <= 0) return clamp(pos, 0, srcDur);
      const mod = pos % srcDur;
      return mod < 0 ? mod + srcDur : mod;
    },
    rateAt: (globalMs: Ms): number => {
      const local = clamp(globalMs - startMs, 0, endLocal);
      return integral.rateAt(local);
    },
    gainAt,
    gainPoints,
  };
}

/**
 * 解算出的「声音是否还在响」的判据（引擎与预览共用同一口径）：
 * 起点已过、终点未到。终点由 evaluateVoice 给出（含源播完/stop/终界）。
 */
export function isAudible(v: VoiceTimeline, nowMs: Ms): boolean {
  return nowMs >= v.startMs && nowMs < v.endMs;
}

/** 终界：全局毫秒 */
function endMsOf(startMs: Ms, endLocal: Ms): Ms {
  return startMs + endLocal;
}

/** 基础速率分段：恒速 / 恒速率 / warp 锚点斜率 */
function buildBasePieces(
  rate: AudioRate | null,
  sourceDurationMs: Ms,
): RatePiece[] {
  if (!rate) return [constPiece(0, 1)];
  if (rate.kind === "rate") {
    if (!(rate.value > 0))
      throw specViolation(`rate=${rate.value} 非法（须为正数）`);
    return [constPiece(0, rate.value)];
  }
  const w = resolveWarp(rate.points as readonly WarpPoint[], sourceDurationMs);
  return ratePiecesOf(w.points);
}

/** 常量速率段（向右无限延伸，后续 setRate 再切分） */
function constPiece(fromMs: Ms, rate: number, sourceFrom = 0): RatePiece {
  return {
    fromMs,
    toMs: Infinity,
    fromRate: rate,
    toRate: rate,
    sourceFrom,
  };
}

function ratePiecesOf(
  points: readonly { readonly atMs: Ms; readonly srcMs: Ms }[],
): RatePiece[] {
  if (points.length === 1)
    return [
      { fromMs: 0, toMs: Infinity, fromRate: 1, toRate: 1, sourceFrom: 0 },
    ];
  const out: RatePiece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = b.atMs - a.atMs;
    out.push({
      fromMs: a.atMs,
      toMs: b.atMs,
      fromRate: (b.srcMs - a.srcMs) / len,
      toRate: (b.srcMs - a.srcMs) / len,
      sourceFrom: a.srcMs,
    });
  }
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const r = (last.srcMs - prev.srcMs) / (last.atMs - prev.atMs);
  out.push({
    fromMs: last.atMs,
    toMs: Infinity,
    fromRate: r,
    toRate: r,
    sourceFrom: last.srcMs,
  });
  return out;
}

/** 运行期 setRate：在调用时刻切分并覆盖其后速率（先爬坡后常量） */
function applyOps(base: RatePiece[], voice: AudioVoice): RatePiece[] {
  const rateOps = voice.ops
    .filter((o): o is RateOp => o.kind === "rate")
    .slice()
    .sort((a, b) => a.atMs - b.atMs);
  if (rateOps.length === 0) return base;
  let pieces = base;
  for (const op of rateOps) {
    const local = Math.max(0, op.atMs - voice.startMs);
    const head = splitAt(pieces, local);
    const sourceFrom = integrate(head, local);
    const from = rateAtPieces(head, local);
    if (!(op.value > 0))
      throw specViolation(`setRate(${op.value}) 非法（须为正数）`);
    const ramp = Math.max(0, op.rampMs ?? 0);
    const rampPiece: RatePiece = {
      fromMs: local,
      toMs: local + ramp,
      fromRate: from,
      toRate: op.value,
      sourceFrom,
    };
    const after = constPiece(
      local + ramp,
      op.value,
      sourceFrom + area(rampPiece, ramp),
    );
    pieces = [...head, ...(ramp > 0 ? [rampPiece] : []), after];
  }
  return pieces;
}

/** 取覆盖 [0, local] 的分段（在 local 处切断；其后被覆盖丢弃） */
function splitAt(pieces: RatePiece[], local: Ms): RatePiece[] {
  const head: RatePiece[] = [];
  for (const p of pieces) {
    if (p.fromMs >= local) break;
    if (p.toMs <= local) {
      head.push(p);
      continue;
    }
    const d = local - p.fromMs;
    head.push({
      fromMs: p.fromMs,
      toMs: local,
      fromRate: p.fromRate,
      toRate: rateOfPiece(p, d),
      sourceFrom: p.sourceFrom,
    });
  }
  return head;
}

/** 段内位移 d 毫秒对应的源内增量 */
function area(p: RatePiece, d: Ms): Ms {
  if (!(d > 0)) return 0;
  const len = p.toMs - p.fromMs;
  if (!Number.isFinite(len)) return p.fromRate * d;
  if (len <= 0 || p.fromRate === p.toRate) return p.fromRate * d;
  const k = (p.toRate - p.fromRate) / len;
  return p.fromRate * d + (k * d * d) / 2;
}

/** 段内位移 d 毫秒后的瞬时速率 */
function rateOfPiece(p: RatePiece, d: Ms): number {
  const len = p.toMs - p.fromMs;
  if (!Number.isFinite(len) || len <= 0) return p.fromRate;
  return p.fromRate + ((p.toRate - p.fromRate) * clamp(d, 0, len)) / len;
}

/** 分段积分的对外面：at(local) / inverse(source) / rateAt(local) */
function makeIntegral(pieces: RatePiece[]) {
  return {
    at(local: Ms): Ms {
      return integrate(pieces, local);
    },
    inverse(target: Ms): Ms {
      let acc = 0;
      for (const p of pieces) {
        const span = Number.isFinite(p.toMs) ? p.toMs - p.fromMs : 0;
        const total = Number.isFinite(p.toMs) ? area(p, span) : Infinity;
        if (Number.isFinite(total) && acc + total < target) {
          acc += total;
          continue;
        }
        const rem = target - acc;
        if (!Number.isFinite(p.toMs)) {
          const d = rem / p.fromRate;
          return p.fromMs + d;
        }
        const d = invertArea(p, rem);
        return p.fromMs + d;
      }
      return pieces.length > 0 ? pieces[pieces.length - 1]!.fromMs : 0;
    },
    rateAt(local: Ms): number {
      return rateAtPieces(pieces, local);
    },
  };
}

/** 逆解段内位移：area(p, d) = rem → d（线性/二次解析） */
function invertArea(p: RatePiece, rem: Ms): Ms {
  if (!(rem > 0)) return 0;
  const len = p.toMs - p.fromMs;
  if (!Number.isFinite(len) || p.fromRate === p.toRate) return rem / p.fromRate;
  const a = (p.toRate - p.fromRate) / (2 * len);
  if (Math.abs(a) < 1e-12) return rem / p.fromRate;
  const b = p.fromRate;
  const disc = b * b + 4 * a * rem;
  const d = (2 * rem) / (b + Math.sqrt(Math.max(0, disc)));
  return clamp(d, 0, len);
}

function integrate(pieces: RatePiece[], local: Ms): Ms {
  let acc = 0;
  for (const p of pieces) {
    if (local <= p.fromMs) break;
    const span = Math.min(local, p.toMs) - p.fromMs;
    acc += area(p, span);
    if (local <= p.toMs) break;
  }
  return acc;
}

function rateAtPieces(pieces: RatePiece[], local: Ms): number {
  let r = pieces[0]?.fromRate ?? 1;
  for (const p of pieces) {
    if (local < p.fromMs) break;
    r = rateOfPiece(p, local - p.fromMs);
    if (local < p.toMs) return r;
  }
  return r;
}

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

type StopOp = Extract<AudioVoice["ops"][number], { kind: "stop" }>;
type GainOp = Extract<AudioVoice["ops"][number], { kind: "gain" }>;
type RateOp = Extract<AudioVoice["ops"][number], { kind: "rate" }>;

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

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function specViolation(message: string): Error {
  const err = new Error(`spec_violation: ${message}`);
  err.name = "SpecViolation";
  return err;
}
