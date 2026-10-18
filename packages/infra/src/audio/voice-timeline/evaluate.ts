/** 声音求值入口：voice + 源时长 + 总时间线终点 → 可执行时间线。 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";
import { buildGainPoints, lastOp, sampleLinear } from "./gains";
import { clamp } from "./helpers";
import { applyOps, buildBasePieces, makeIntegral } from "./rate";
import type { VoiceTimeline } from "./types";

/**
 * 求值：voice + 源时长 + 总时间线终点 → 可执行时间线。
 *
 * 时间轴定义：voice.startMs 为全局起点；local = 全局毫秒 - startMs。
 * 源位置 = 速率对时间线积分 M(local) = ∫₀^local rate dt：
 *  - 基础段来自 rate（恒速或 warp 锚点斜率）；
 *  - 运行期 setRate 在调用时刻切分，先线性爬坡再常量（覆盖其后）；
 *  - loop 时源位置取 M(local) 对源时长的余数（源空间回卷）。
 *
 * 终界规则：总时间线尾是唯一硬界，再取 stop、loop 的 untilMs（契约给定的是时间线毫秒，
 * 这里换算成相对声音起点的局部毫秒）、非循环时再取源播完时刻的最小值。
 * 求值只发生一次，结果供出片与预览共用。
 *
 * @param voice 声音实例（全局起点、素材/合成、增益包络、声像、循环、变速、运行期操作）
 * @param sourceDurationMs 源时长（毫秒；0 表示无源可播，非循环声音该帧即结束）
 * @param timelineEndMs 总时间线终点（全局毫秒），声音不会越过它
 * @returns 可执行时间线（起止、循环、声像、源位置/速率/增益的取值函数与增益折点）
 */
export function evaluateVoice(
  voice: AudioVoice,
  sourceDurationMs: Ms,
  timelineEndMs: Ms,
): VoiceTimeline {
  const startMs = voice.startMs;
  /** 基础速率段叠加运行期 setRate 之后的分段表 */
  const pieces = applyOps(buildBasePieces(voice.rate, sourceDurationMs), voice);
  /** 速率对时间的解析积分（正向取源位置、逆向取源播完时刻） */
  const integral = makeIntegral(pieces);
  const loop = voice.loop !== null;
  /** 源时长（负值按 0） */
  const srcDur = Math.max(0, sourceDurationMs);

  // 自然收尾 / 循环时长：源被放完所需的局部时间（速率可变，故用逆积分）
  const naturalMs = srcDur > 0 ? integral.inverse(srcDur) : 0;
  const stopOp = lastOp(voice, "stop");
  /** 停声时刻（局部毫秒；无停声操作时为 Infinity） */
  const stopMs = stopOp ? Math.max(0, stopOp.atMs - startMs) : Infinity;
  const untilMs = voice.loop?.untilMs;
  /** 循环终点（局部毫秒；`untilMs` 是时间线毫秒，减起点换算；未声明时不受此界） */
  const untilLocal =
    untilMs === undefined ? Infinity : Math.max(0, untilMs - startMs);

  // 终界规则：总时间线尾是唯一硬界；再看 stop / until / 源播完
  /** 总时间线尾对应的局部毫秒（声音起点不会越过它） */
  const hardEnd = Math.max(0, timelineEndMs - startMs);
  let endLocal = Math.min(hardEnd, stopMs);
  if (loop) endLocal = Math.min(endLocal, untilLocal);
  else endLocal = Math.min(endLocal, naturalMs);
  if (endLocal < 0) endLocal = 0;

  /** 增益折点（全局毫秒） */
  const gainPoints = buildGainPoints(voice, startMs, endLocal, naturalMs);
  /** 全局毫秒处的线性增益（折点之间线性插值，端点外取端点值） */
  const gainAt = (globalMs: Ms): number => sampleLinear(gainPoints, globalMs);

  return {
    startMs,
    endMs: startMs + endLocal,
    loop,
    pan: voice.pan.value,
    sourceMsAt: (globalMs: Ms): Ms => {
      /** 声音内局部毫秒（钳到可听区间） */
      const local = clamp(globalMs - startMs, 0, endLocal);
      const pos = integral.at(local);
      if (!loop || srcDur <= 0) return clamp(pos, 0, srcDur);
      /** loop 时的源空间余数（钳在 [0, srcDur)） */
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
 *
 * 区间为左闭右开：起点那一帧算响，终点那一帧不算。
 *
 * @param v 已求值的时间线
 * @param nowMs 当前全局毫秒
 * @returns 是否在可听区间内
 */
export function isAudible(v: VoiceTimeline, nowMs: Ms): boolean {
  return nowMs >= v.startMs && nowMs < v.endMs;
}
