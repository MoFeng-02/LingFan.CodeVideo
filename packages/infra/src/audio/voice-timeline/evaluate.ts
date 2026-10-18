/** 声音求值入口：voice + 源时长 + 总时间线终点 → 可执行时间线。 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";
import { buildGainPoints, lastOp, sampleLinear } from "./gains";
import { clamp } from "./helpers";
import { applyOps, buildBasePieces, makeIntegral } from "./rate";
import type { VoiceTimeline } from "./types";

/**
 * 求值：voice + 源时长 + 总时间线终点 → 可执行时间线。
 * 时间轴定义：voice.startMs 为全局起点；local = 全局毫秒 - startMs。
 * 源位置 = 速率对时间线积分 M(local) = ∫₀^local rate dt：
 *  - 基础段来自 rate（恒速或 warp 锚点斜率）；
 *  - 运行期 setRate 在调用时刻切分，先线性爬坡再常量（覆盖其后）；
 *  - loop 时源位置取 M(local) 对源时长的余数（源空间回卷）。
 */
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
