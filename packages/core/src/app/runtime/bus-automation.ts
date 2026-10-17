import type { AutomationPoint, BusId, Ms } from "@lingfan-video/contracts";
import type { TimelineState } from "./engine-types";
import {
  ensureBusParams,
  registerParamRamp,
  writeBusParams,
} from "./audio-graph";

/**
 * 一条已全局化的声明式轨迹：points 按全局时刻升序，cursor 指向下一个未生效点。
 * 生效即前进游标，因此每点恰好作用一次（重复渲染同一时刻不会重放）。
 */
export interface DeclaredAutomation {
  points: AutomationPoint[];
  cursor: number;
}

/** 安装一条轨迹（总线参数面按需懒建；已存在则替换） */
export function installAutomation(
  state: TimelineState,
  bus: BusId,
  points: AutomationPoint[],
): void {
  if (points.length === 0) return;
  ensureBusParams(state, bus);
  state.busAutomation.set(bus, { points, cursor: 0 });
}

/**
 * 帧首推进：把已到点的声明落成参数目标，过渡起点取**声明时刻**
 * （而非当前帧时刻），这样曲线在帧格上保持时间精确，帧间由混音端线性插值。
 */
export function applyAutomation(state: TimelineState, t: Ms): void {
  for (const [bus, queue] of state.busAutomation) {
    while (queue.cursor < queue.points.length) {
      const point = queue.points[queue.cursor]!;
      if (point.atMs > t) break;
      queue.cursor++;
      applyPoint(state, bus, point);
    }
  }
}

/** 单个点的生效：只写点里给出的参数（未给出的不动） */
function applyPoint(
  state: TimelineState,
  bus: BusId,
  point: AutomationPoint,
): void {
  if (point.gain !== undefined) {
    const gain = Math.max(0, point.gain);
    registerParamRamp(state, bus, "gain", gain, point.rampMs, point.atMs);
    writeBusParams(state, bus, { gain });
  }
  if (point.pan !== undefined) {
    const pan = Math.max(-1, Math.min(1, point.pan));
    registerParamRamp(state, bus, "pan", pan, point.rampMs, point.atMs);
    writeBusParams(state, bus, { pan });
  }
}
