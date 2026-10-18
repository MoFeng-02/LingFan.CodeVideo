/** 速率分段与积分：基础段（恒速/恒速率/warp）→ 运行期 setRate 切分 → 分段积分与逆解。 */
import type {
  AudioRate,
  AudioVoice,
  Ms,
  WarpPoint,
} from "@lingfan-video/contracts";
import { resolveWarp } from "../warp";
import { clamp, specViolation } from "./helpers";
import type { RateOp, RatePiece } from "./types";

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

export {
  applyOps,
  area,
  buildBasePieces,
  constPiece,
  integrate,
  invertArea,
  makeIntegral,
  rateAtPieces,
  rateOfPiece,
  ratePiecesOf,
  splitAt,
};
