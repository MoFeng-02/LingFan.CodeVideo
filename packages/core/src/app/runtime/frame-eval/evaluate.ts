import type { FrameIndex, Ms } from "@lingfan-video/contracts";
import { sampleBuses } from "../audio-graph";
import { applyAutomation } from "../bus-automation";
import type { ChainSpan, EvalDeps, SpawnChain } from "../engine-types";
import { findSpans, findSpansLooping } from "../timeline-build";
import {
  evalLoopIter,
  evalSelfPacedLoop,
  evalStep,
  evalWait,
} from "./contexts";
import { chainDisposal, unitDisposal } from "./disposal";

/** 逐帧求值：绘制顺序 spawn 链（背景）在前、登记链在后 */
export function evaluateFrame(deps: EvalDeps, f: FrameIndex, t: Ms): void {
  const { state } = deps;
  state.nowMs = t; // 句柄操作/声音 alive 的时间轴依据 = 当前求值时刻
  // 输入快照与自动化都先于回调落地：同帧所有单元看到同一份输入
  state.nowInput = state.input.snapshotAt(t);
  // 声明式轨迹先于回调生效：到点的计划在这一帧之前就已落地
  applyAutomation(state, t);
  const ordered: Array<{ chain: SpawnChain | null; span: ChainSpan }> = [];
  for (const c of state.spawnChains) {
    if (c.killed || t < c.start || t >= c.end) continue;
    // 消亡窗口到期 = 真正出池
    if (c.dyingUntil !== undefined && t >= c.dyingUntil) continue;
    // forever 链内容播完后循环重放（回卷 span）；一次性链照常查
    for (const span of findSpansLooping(c, t)) ordered.push({ chain: c, span });
  }
  // 主链可能有多段同时活跃（transitionTo 的重叠窗）：按链上顺序逐段求值
  for (const span of findSpans(state.spans, t))
    ordered.push({ chain: null, span });

  for (const { chain, span } of ordered) {
    const localT = t - span.start;
    const chainDisp = chainDisposal(chain, t);
    for (const unit of span.seg.units) {
      const deadKey = `${span.scene.id}/${unit.key}`;
      const hostKey = unit.loopBase
        ? `${span.scene.id}/${unit.loopBase}`
        : deadKey;
      if (state.deadUnits.has(deadKey)) continue;
      // loop stop() 按宿主杀全迭代（loopBase 锚点）
      if (unit.loopBase && state.deadUnits.has(hostKey)) continue;
      // 消亡窗口到期 → 转硬死（此后不再求值）
      for (const k of new Set([deadKey, hostKey])) {
        const d = state.dyingUnits.get(k);
        if (d && t >= d.until) state.deadUnits.add(k);
      }
      if (state.deadUnits.has(deadKey)) continue;
      if (unit.loopBase && state.deadUnits.has(hostKey)) continue;
      if (localT < unit.windowStart || localT >= unit.windowEnd) {
        if (unit.hold && localT >= unit.windowEnd)
          deps.aggregator.touchHold(`${span.scene.id}/${unit.key}`); // hold 冻结糖
        continue;
      }
      const disp =
        unitDisposal(deps, [...new Set([deadKey, hostKey])], t) ?? chainDisp;
      if (unit.onUpdate)
        evalWait(
          deps,
          span,
          unit,
          f,
          t,
          localT - unit.windowStart,
          hostKey,
          disp,
        );
      else if (unit.loop && unit.loop.iterationMs === undefined)
        evalSelfPacedLoop(
          deps,
          span,
          unit,
          f,
          t,
          localT,
          chain,
          deadKey,
          hostKey,
          disp,
        );
      else if (unit.loop)
        evalLoopIter(
          deps,
          span,
          unit,
          f,
          t,
          localT - unit.windowStart,
          chain,
          hostKey,
          disp,
        );
      else
        evalStep(
          deps,
          span,
          unit,
          f,
          t,
          localT - unit.windowStart,
          chain,
          hostKey,
          disp,
        );
    }
  }
  sampleBuses(deps, t);
}
