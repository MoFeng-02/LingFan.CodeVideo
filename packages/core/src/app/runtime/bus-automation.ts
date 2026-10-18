import type { AutomationPoint, BusId, Ms } from "@lingfan-video/contracts";
import { toLinearGain } from "../../domain/audio/gain-units";
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
  /** 轨迹点（全局毫秒升序；每个点只写自己要控制的参数） */
  points: AutomationPoint[];
  /** 下一个未生效点的下标；随帧推进只增不减 */
  cursor: number;
}

/**
 * 安装一条轨迹（总线参数面按需懒建；已存在则替换）。
 *
 * 每条总线至多一条在途轨迹：后安装的整条替换先前的（同一剧本里重复声明时以最后一次为准）。
 *
 * @param state 引擎状态
 * @param bus 总线标识（未知总线在构建图时回落 master）
 * @param points 已全局化的轨迹点（毫秒升序；空数组不安装）
 */
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
 *
 * 每帧只处理「本帧时刻及之前」尚未生效的点；同一帧到达多个点时按轨迹顺序依次生效。
 *
 * @param state 引擎状态（轨迹队列游标在推进）
 * @param t 当前帧时刻（时间线毫秒）
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
    // 分贝在此折算：轨迹下游（预览/导出）只见线性幅度
    const gain = Math.max(
      0,
      toLinearGain(point.gain, `automation 第 ${point.atMs}ms 点 gain`),
    );
    registerParamRamp(state, bus, "gain", gain, point.rampMs, point.atMs);
    writeBusParams(state, bus, { gain });
  }
  if (point.pan !== undefined) {
    const pan = Math.max(-1, Math.min(1, point.pan));
    registerParamRamp(state, bus, "pan", pan, point.rampMs, point.atMs);
    writeBusParams(state, bus, { pan });
  }
}
