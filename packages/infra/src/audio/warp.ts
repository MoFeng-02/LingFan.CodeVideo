/**
 * 时间映射（warp）解析与求值：音频「时间线时间 → 源内时间」的唯一换算点。
 *
 * 出片端离线混音与预览端 WebAudio 排程共用本模块——两端由同一张表推导，
 * 不允许各自实现一套（否则预览与出片必然漂移）。
 *
 * 语义：锚点之间线性插值，斜率 = 播放速率 = 音高倍率（磁带式重采样）；
 * 末个锚点之后斜率延续。首点 atMs>0 时其前为原速恒等段（隐式 (0,0)）。
 */
import type { Ms, WarpPoint } from "@lingfan-video/contracts";

/** 解析后的锚点：srcMs 已落实为数（无 "end" 符号），至少一点且首点 atMs=0 */
export interface ResolvedWarp {
  /** 锚点表：atMs 与 srcMs 均严格递增（毫秒），斜率为正 = 不倒放 */
  readonly points: readonly { readonly atMs: Ms; readonly srcMs: Ms }[];
  /** 源结尾处（毫秒），由调用方解码结果提供 */
  readonly sourceDurationMs: Ms;
}

/** 速率分段（预览端按段设 playbackRate；出片端不用，直接解析积分） */
export interface WarpRateSegment {
  /** 该段在事件内局部时间线起点（毫秒） */
  readonly fromMs: Ms;
  /** 该段速率（1 = 原速；>1 加速升调；<1 减速降调） */
  readonly rate: number;
}

/**
 * 解析锚点表：落实 "end"、补隐式恒等首点、校验单调性。
 *
 * 校验失败抛 SpecViolation（非正速率 = 时间倒流，无法产生样本）。
 * "end" 只允许出现在末位；首点 atMs>0 时会在最前面补一个 (0, 0) 锚点，
 * 因此返回值至少一点且首点 atMs=0。
 *
 * @param warp 声明锚点（可缺省/为空，表示原速恒等映射）
 * @param sourceDurationMs 源时长（毫秒），用于落实 "end"
 * @returns 解析后的锚点表 + 源时长
 * @throws Error name 为 "SpecViolation"：某点非有限/为负、两轴未严格递增，或 "end" 不在末位
 */
export function resolveWarp(
  warp: readonly WarpPoint[] | undefined,
  sourceDurationMs: Ms,
): ResolvedWarp {
  if (!warp || warp.length === 0)
    return { points: [{ atMs: 0, srcMs: 0 }], sourceDurationMs };
  /** 声明表的末位下标（"end" 只允许在此） */
  const last = warp.length - 1;
  const points = warp.map((p, i) => {
    if (p.srcMs === "end") {
      if (i !== last)
        throw specViolation(
          `warp 第 ${i} 点 srcMs="end" 只允许末位（源尾之后无锚点可言）`,
        );
      return { atMs: p.atMs, srcMs: sourceDurationMs };
    }
    return { atMs: p.atMs, srcMs: p.srcMs };
  });
  // 首点晚于 0：其前按原速播放（等价于隐式 (0,0) 锚点）
  if (points[0]!.atMs > 0) points.unshift({ atMs: 0, srcMs: 0 });
  assertMonotone(points);
  return { points, sourceDurationMs };
}

/**
 * 事件内局部时间线毫秒 → 源内毫秒（线性插值；末点后斜率延续）。
 *
 * 只有一个锚点时退化为恒等平移（srcMs = 锚点 srcMs + timelineMs）。
 * 返回值可能超过 sourceDurationMs：是否截断由调用方决定（循环/停声语义在上层）。
 *
 * @param w 解析后的映射
 * @param timelineMs 事件内局部时间（毫秒，0 = 声音起点）
 * @returns 源内时间（毫秒）
 */
export function sourceMsAt(w: ResolvedWarp, timelineMs: Ms): Ms {
  const ps = w.points;
  if (ps.length === 1) return ps[0]!.srcMs + timelineMs;
  /** 末锚点下标 */
  const lastIdx = ps.length - 1;
  if (timelineMs >= ps[lastIdx]!.atMs) {
    /** 末段速率（末点之后沿用的斜率） */
    const rate = rateOf(ps[lastIdx - 1]!, ps[lastIdx]!);
    return ps[lastIdx]!.srcMs + (timelineMs - ps[lastIdx]!.atMs) * rate;
  }
  for (let i = 0; i < lastIdx; i++) {
    const a = ps[i]!;
    const b = ps[i + 1]!;
    if (timelineMs < b.atMs)
      return a.srcMs + (timelineMs - a.atMs) * rateOf(a, b);
  }
  // 不可达（末段已由上面的 >= 分支覆盖）
  return ps[lastIdx]!.srcMs;
}

/**
 * 源内毫秒 → 事件内局部时间线毫秒（逆映射；用于推演源播放完的时刻）。
 *
 * 与 `sourceMsAt` 同一张表的逆运算；末点之后同样沿用末段斜率。单锚点时退化为恒等平移。
 *
 * @param w 解析后的映射
 * @param sourceMs 源内时间（毫秒）
 * @returns 事件内局部时间（毫秒）
 */
export function timelineMsAtSource(w: ResolvedWarp, sourceMs: Ms): Ms {
  const ps = w.points;
  if (ps.length === 1) return ps[0]!.atMs + (sourceMs - ps[0]!.srcMs);
  const lastIdx = ps.length - 1;
  if (sourceMs >= ps[lastIdx]!.srcMs) {
    const rate = rateOf(ps[lastIdx - 1]!, ps[lastIdx]!);
    return ps[lastIdx]!.atMs + (sourceMs - ps[lastIdx]!.srcMs) / rate;
  }
  for (let i = 0; i < lastIdx; i++) {
    const a = ps[i]!;
    const b = ps[i + 1]!;
    if (sourceMs < b.srcMs) return a.atMs + (sourceMs - a.srcMs) / rateOf(a, b);
  }
  return ps[lastIdx]!.atMs;
}

/**
 * 速率分段表（预览端排程用：逐段设 playbackRate）。
 *
 * 只覆盖到末个锚点：AudioParam 末值会一直延续，正好就是「不恢复就一直那样」。
 * 段起点是锚点的 atMs，段速率是相邻锚点之间的 Δ源/Δ时间线。
 *
 * @param w 解析后的映射
 * @returns 速率分段（按 fromMs 递增；单锚点时只有一段恒速 1）
 */
export function rateSegments(w: ResolvedWarp): WarpRateSegment[] {
  const ps = w.points;
  if (ps.length === 1) return [{ fromMs: 0, rate: 1 }];
  const out: WarpRateSegment[] = [];
  for (let i = 0; i < ps.length - 1; i++)
    out.push({ fromMs: ps[i]!.atMs, rate: rateOf(ps[i]!, ps[i + 1]!) });
  return out;
}

/**
 * 段速率：Δ源/Δ时间线（两者均由锚点直接给出）。
 *
 * @param a 段起点锚点（atMs/srcMs，毫秒）
 * @param b 段终点锚点（atMs/srcMs，毫秒）
 * @returns 速率（> 0；1 = 原速）
 */
function rateOf(
  a: { atMs: Ms; srcMs: Ms },
  b: { atMs: Ms; srcMs: Ms },
): number {
  return (b.srcMs - a.srcMs) / (b.atMs - a.atMs);
}

/**
 * 单调性校验：时间线严格递增、源严格递增（速率恒正，禁倒放）。
 *
 * @param points 待校验的锚点表（已落实 "end" 与隐式首点）
 * @throws Error name 为 "SpecViolation"：某点非有限/为负，或两轴未严格递增
 */
function assertMonotone(points: readonly { atMs: Ms; srcMs: Ms }[]): void {
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!Number.isFinite(p.atMs) || p.atMs < 0)
      throw specViolation(
        `warp 第 ${i} 点 atMs=${p.atMs} 非法（须为 ≥0 的有限毫秒）`,
      );
    if (!Number.isFinite(p.srcMs) || p.srcMs < 0)
      throw specViolation(
        `warp 第 ${i} 点 srcMs=${p.srcMs} 非法（须为 ≥0 的有限毫秒）`,
      );
    if (i === 0) continue;
    const prev = points[i - 1]!;
    if (p.atMs <= prev.atMs)
      throw specViolation(
        `warp 第 ${i} 点 atMs=${p.atMs} 未严格递增（前一点 ${prev.atMs}）`,
      );
    if (p.srcMs <= prev.srcMs)
      throw specViolation(
        `warp 第 ${i} 点 srcMs=${p.srcMs} 未递增（前一点 ${prev.srcMs}）——速率须为正，禁倒放`,
      );
  }
}

/**
 * 契约违约错误（名称与组合根一致：SpecViolation）。
 *
 * @param message 具体原因（不含前缀，前缀由本函数补）
 * @returns name 为 "SpecViolation" 的 Error
 */
function specViolation(message: string): Error {
  const err = new Error(`spec_violation: ${message}`);
  err.name = "SpecViolation";
  return err;
}
