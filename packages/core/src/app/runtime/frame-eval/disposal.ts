import type { Ms } from "@lingfan-video/contracts";
import type { EvalDeps } from "../engine-types";
import type { SpawnChain } from "../engine-types";

/** 消亡窗口状态（disposing + 进度；窗口外恒 false/0） */
export interface DisposalInfo {
  disposing: boolean;
  progress: number;
}

export const NONE: DisposalInfo = { disposing: false, progress: 0 };

function progressIn(from: Ms, until: Ms, t: Ms): number {
  if (until <= from) return 1;
  return Math.min(1, Math.max(0, (t - from) / (until - from)));
}

/** 链级消亡：整条链共享一个窗口（窗口内所有单元都看到 disposing） */
export function chainDisposal(chain: SpawnChain | null, t: Ms): DisposalInfo {
  if (!chain || chain.dyingFrom === undefined || chain.dyingUntil === undefined)
    return NONE;
  if (t < chain.dyingFrom || t >= chain.dyingUntil) return NONE;
  return {
    disposing: true,
    progress: progressIn(chain.dyingFrom, chain.dyingUntil, t),
  };
}

/** 单元级消亡：按宿主键/单元键查窗口 */
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
