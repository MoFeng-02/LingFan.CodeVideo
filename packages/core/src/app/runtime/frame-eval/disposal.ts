/**
 * 消亡窗口求值：kill/dispose 带 fadeOut 时，目标在窗口内继续逐帧求值，
 * 回调据此拿到 `disposing` 与 0→1 的 `disposeProgress` 做淡出。
 *
 * 窗口到期即真正出池（之后不再求值）；不带 fadeOut 的消杀不走这里，直接硬死。
 */
import type { Ms } from "@lingfan-video/contracts";
import type { EvalDeps } from "../engine-types";
import type { SpawnChain } from "../engine-types";

/** 消亡窗口状态（窗口外恒 false/0） */
export interface DisposalInfo {
  /** 是否正处在消亡窗口内（窗口内本单元/本链仍逐帧求值） */
  disposing: boolean;
  /** 窗口进度：0 = 窗口起点，1 = 窗口终点；窗口外为 0 */
  progress: number;
}

/** 窗口外的常量：不在消亡中，进度 0 */
export const NONE: DisposalInfo = { disposing: false, progress: 0 };

function progressIn(from: Ms, until: Ms, t: Ms): number {
  if (until <= from) return 1;
  return Math.min(1, Math.max(0, (t - from) / (until - from)));
}

/**
 * 链级消亡：整条链共享一个窗口（窗口内所有单元都看到 disposing）。
 *
 * @param chain 所属 spawn 链；主链单元传 `null`
 * @param t 当前求值时刻（时间线毫秒）
 * @returns 窗口内的状态与进度；不在窗口内（或链不存在）返回 {@link NONE}
 */
export function chainDisposal(chain: SpawnChain | null, t: Ms): DisposalInfo {
  if (!chain || chain.dyingFrom === undefined || chain.dyingUntil === undefined)
    return NONE;
  if (t < chain.dyingFrom || t >= chain.dyingUntil) return NONE;
  return {
    disposing: true,
    progress: progressIn(chain.dyingFrom, chain.dyingUntil, t),
  };
}

/**
 * 单元级消亡：按宿主键/单元键查窗口。
 *
 * @param deps 求值依赖（读 `state.dyingUnits`）
 * @param keys 候选键（宿主键与单元键；命中任一窗口即生效）
 * @param t 当前求值时刻（时间线毫秒）
 * @returns 窗口内的状态与进度；都不在窗口内时 `undefined`（调用方回退链级判定）
 */
export function unitDisposal(
  deps: EvalDeps,
  keys: string[],
  t: Ms,
): DisposalInfo | undefined {
  for (const k of keys) {
    const d = deps.state.dyingUnits.get(k);
    if (d && t >= d.from && t < d.until)
      return { disposing: true, progress: progressIn(d.from, d.until, t) };
  }
  return undefined;
}
