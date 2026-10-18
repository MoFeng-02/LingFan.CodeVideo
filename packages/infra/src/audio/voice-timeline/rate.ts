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

/**
 * 基础速率分段：恒速 / 恒速率 / warp 锚点斜率。
 *
 * 未声明变速时得到一段恒速 1、向右无限延伸的分段；warp 锚点表经 `resolveWarp`
 * 解析后转成分段速率。速率必须为正（非正 = 时间倒流或倒放，无法产生样本）。
 *
 * @param rate 变速声明（null/缺省 = 原速）
 * @param sourceDurationMs 源时长（毫秒，用于落实 warp 的 "end" 锚点）
 * @returns 基础分段（首段从 0 起，末段延伸到无穷）
 * @throws Error name 为 "SpecViolation"：恒速值非正，或 warp 锚点非法
 */
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

/**
 * 常量速率段（向右无限延伸，后续 setRate 再切分）。
 *
 * @param fromMs 段起点（局部毫秒）
 * @param rate 段速率（1 = 原速，须 > 0）
 * @param sourceFrom 段起点对应的源内毫秒（缺省 0）
 * @returns 恒速分段（toMs = Infinity）
 */
function constPiece(fromMs: Ms, rate: number, sourceFrom = 0): RatePiece {
  return {
    fromMs,
    toMs: Infinity,
    fromRate: rate,
    toRate: rate,
    sourceFrom,
  };
}

/**
 * warp 锚点 → 分段速率：相邻锚点之间一段，斜率即段速率；末锚点之后按末段斜率延续。
 *
 * @param points 解析后的锚点（atMs/srcMs 均严格递增，毫秒）
 * @returns 速率分段（首段 fromMs = 0，末段 toMs = Infinity）
 */
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
    /** 段长（毫秒，> 0） */
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
  /** 末段斜率（末锚点之后沿用） */
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

/**
 * 运行期 setRate：在调用时刻切分并覆盖其后速率（先爬坡后常量）。
 *
 * 每个操作都按 atMs 升序生效：先在该时刻切断已有分段，再插入一段线性爬坡
 * （从当时的瞬时速率到目标值），最后接一段目标值的常量段。
 *
 * @param base 基础分段（会被逐步替换，不就地修改数组）
 * @param voice 声音实例（取其中的 rate 操作）
 * @returns 叠加运行期操作之后的分段表
 * @throws Error name 为 "SpecViolation"：目标速率非正
 */
function applyOps(base: RatePiece[], voice: AudioVoice): RatePiece[] {
  /** 运行期速率操作（按生效时刻升序） */
  const rateOps = voice.ops
    .filter((o): o is RateOp => o.kind === "rate")
    .slice()
    .sort((a, b) => a.atMs - b.atMs);
  if (rateOps.length === 0) return base;
  let pieces = base;
  for (const op of rateOps) {
    /** 操作生效的声音内局部毫秒 */
    const local = Math.max(0, op.atMs - voice.startMs);
    /** 覆盖 [0, local] 的已有分段 */
    const head = splitAt(pieces, local);
    /** 生效时刻已累积的源内毫秒 */
    const sourceFrom = integrate(head, local);
    /** 生效时刻的瞬时速率（爬坡起点） */
    const from = rateAtPieces(head, local);
    if (!(op.value > 0))
      throw specViolation(`setRate(${op.value}) 非法（须为正数）`);
    const ramp = Math.max(0, op.rampMs ?? 0);
    /** 爬坡段：从当前速率线性到目标速率 */
    const rampPiece: RatePiece = {
      fromMs: local,
      toMs: local + ramp,
      fromRate: from,
      toRate: op.value,
      sourceFrom,
    };
    /** 爬坡结束后的常量段（向右无限延伸） */
    const after = constPiece(
      local + ramp,
      op.value,
      sourceFrom + area(rampPiece, ramp),
    );
    pieces = [...head, ...(ramp > 0 ? [rampPiece] : []), after];
  }
  return pieces;
}

/**
 * 取覆盖 [0, local] 的分段（在 local 处切断；其后被覆盖丢弃）。
 *
 * @param pieces 既有分段（按 fromMs 递增）
 * @param local 切分点（局部毫秒）
 * @returns 覆盖 [0, local] 的分段（末段可能被截断到 local）
 */
function splitAt(pieces: RatePiece[], local: Ms): RatePiece[] {
  const head: RatePiece[] = [];
  for (const p of pieces) {
    if (p.fromMs >= local) break;
    if (p.toMs <= local) {
      head.push(p);
      continue;
    }
    /** 切分点距段起点的位移（毫秒） */
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

/**
 * 段内位移 d 毫秒对应的源内增量。
 *
 * 常量段为 rate × d；线性爬坡段按梯形/解析二次积分（Δ = r0·d + k·d²/2）。
 *
 * @param p 速率分段
 * @param d 段内位移（毫秒，≤ 0 时为 0）
 * @returns 源内增量（毫秒）
 */
function area(p: RatePiece, d: Ms): Ms {
  if (!(d > 0)) return 0;
  const len = p.toMs - p.fromMs;
  if (!Number.isFinite(len)) return p.fromRate * d;
  if (len <= 0 || p.fromRate === p.toRate) return p.fromRate * d;
  /** 每毫秒的速率变化量 */
  const k = (p.toRate - p.fromRate) / len;
  return p.fromRate * d + (k * d * d) / 2;
}

/**
 * 段内位移 d 毫秒后的瞬时速率。
 *
 * @param p 速率分段
 * @param d 段内位移（毫秒，钳在 [0, 段长]）
 * @returns 该点的速率（1 = 原速）
 */
function rateOfPiece(p: RatePiece, d: Ms): number {
  const len = p.toMs - p.fromMs;
  if (!Number.isFinite(len) || len <= 0) return p.fromRate;
  return p.fromRate + ((p.toRate - p.fromRate) * clamp(d, 0, len)) / len;
}

/**
 * 分段积分的对外面：at(local) / inverse(source) / rateAt(local)。
 *
 * 出片端逐样本按 at/rateAt 取源位置与速率，预览端按 rateAt 排 AudioParam；
 * inverse 用于换算「源播完」对应的局部时间。
 *
 * @param pieces 速率分段（覆盖 [0, ∞)，按 fromMs 递增）
 * @returns 三个查询函数
 */
function makeIntegral(pieces: RatePiece[]) {
  return {
    /**
     * 局部毫秒处已播放的源内毫秒（∫₀^local rate dt）。
     *
     * @param local 局部毫秒
     * @returns 源内毫秒（单调不减）
     */
    at(local: Ms): Ms {
      return integrate(pieces, local);
    },
    /**
     * 逆解：源内 target 毫秒对应第几个局部毫秒。
     *
     * @param target 源内毫秒（≥ 0）
     * @returns 局部毫秒（超出所有有限段时按末段速率外推）
     */
    inverse(target: Ms): Ms {
      let acc = 0;
      for (const p of pieces) {
        /** 段长（毫秒；无限段为 0） */
        const span = Number.isFinite(p.toMs) ? p.toMs - p.fromMs : 0;
        /** 该段可累计的源内总量（无限段为 Infinity） */
        const total = Number.isFinite(p.toMs) ? area(p, span) : Infinity;
        if (Number.isFinite(total) && acc + total < target) {
          acc += total;
          continue;
        }
        /** 段内还需走的源内毫秒 */
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
    /**
     * 局部毫秒处的瞬时速率。
     *
     * @param local 局部毫秒
     * @returns 速率（1 = 原速）
     */
    rateAt(local: Ms): number {
      return rateAtPieces(pieces, local);
    },
  };
}

/**
 * 逆解段内位移：area(p, d) = rem → d（线性/二次解析）。
 *
 * @param p 速率分段
 * @param rem 目标源内增量（毫秒）
 * @returns 段内位移（毫秒，钳在 [0, 段长]）
 */
function invertArea(p: RatePiece, rem: Ms): Ms {
  if (!(rem > 0)) return 0;
  const len = p.toMs - p.fromMs;
  if (!Number.isFinite(len) || p.fromRate === p.toRate) return rem / p.fromRate;
  /** 二次项系数（速率变化率的一半） */
  const a = (p.toRate - p.fromRate) / (2 * len);
  if (Math.abs(a) < 1e-12) return rem / p.fromRate;
  /** 一次项系数 = 段起点速率 */
  const b = p.fromRate;
  const disc = b * b + 4 * a * rem;
  const d = (2 * rem) / (b + Math.sqrt(Math.max(0, disc)));
  return clamp(d, 0, len);
}

/**
 * 累积积分：∫₀^local rate dt（分段求和，边界处取到段尽头）。
 *
 * @param pieces 速率分段（按 fromMs 递增）
 * @param local 局部毫秒
 * @returns 源内毫秒
 */
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

/**
 * 局部毫秒处的瞬时速率（落在哪段就取哪段的线性插值）。
 *
 * @param pieces 速率分段（按 fromMs 递增）
 * @param local 局部毫秒
 * @returns 速率（1 = 原速；无分段时按 1）
 */
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
