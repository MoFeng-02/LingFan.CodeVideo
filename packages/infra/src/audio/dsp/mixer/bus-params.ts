/**
 * 总线参数求值：运行期过渡插值与逐帧自动化预计算。
 *
 * 渲染一个块之前先把每条总线的自动化轨迹求成逐帧数组（查询游标只前进一次），
 * 主循环与独奏判定共用同一份结果，避免同一时刻被反复询问。
 */
import type { BusId, Ms } from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import type { BusParams } from "../graph";
import type {
  BlockParams,
  BusParamsPatch,
  BusRuntime,
  LiveRamp,
} from "./types";

/**
 * 求运行期过渡在某一时刻的值。
 *
 * @param ramp 过渡；未设置时直接返回 fallback（静态值）
 * @param ms 查询时刻（全局毫秒）
 * @param fallback 未设置过渡时的回退值
 * @returns 该时刻的参数值
 */
export function rampAt(
  ramp: LiveRamp | undefined,
  ms: Ms,
  fallback: number,
): number {
  if (!ramp) return fallback;
  if (ramp.rampMs <= 0) return ramp.to;
  const k = Math.min(1, Math.max(0, (ms - ramp.startMs) / ramp.rampMs));
  return ramp.from + (ramp.to - ramp.from) * k;
}

/**
 * 把一个块的自动化轨迹求成每条总线的逐帧参数。
 *
 * 只对有自动化轨迹的总线求值；没有轨迹的总线不占结果（主循环回退到覆盖/静态值）。
 * 自动化查询游标只前进，因此本函数对每条总线只遍历一次块的帧区间。
 *
 * @param order 总线处理顺序（拓扑序）
 * @param automation 总线 id → 自动化查询函数
 * @param startFrame 本块第一帧在输出网格上的帧号
 * @param frames 本块帧数
 * @param sampleRate 输出采样率（Hz，用于帧号换算毫秒）
 * @returns 总线 id → 逐帧参数；无轨迹的总线不在表里
 */
export function blockParamsOf(
  order: readonly BusRuntime[],
  automation: ReadonlyMap<BusId, (ms: Ms) => BusParams>,
  startFrame: number,
  frames: number,
  sampleRate: number,
): Map<BusId, BlockParams> {
  /** 本块逐帧自动化参数：每条总线只求值一次 */
  const blockParams = new Map<BusId, BlockParams>();
  for (const bus of order) {
    const auto = automation.get(bus.id);
    if (!auto) continue;
    const gain = new Float32Array(frames);
    const pan = new Float32Array(frames);
    const mute = new Uint8Array(frames);
    const solo = new Uint8Array(frames);
    for (let fr = 0; fr < frames; fr++) {
      const ms = ((startFrame + fr) * 1000) / sampleRate;
      const p = auto(ms);
      gain[fr] = p.gain;
      pan[fr] = p.pan;
      mute[fr] = p.mute ? 1 : 0;
      solo[fr] = p.solo ? 1 : 0;
    }
    blockParams.set(bus.id, { gain, pan, mute, solo });
  }
  return blockParams;
}

/**
 * 求本块逐帧「是否存在独奏」：静态声明、运行期覆盖与自动化折点都算。
 *
 * master 不参与独奏判定（独奏时 master 仍要把声音送出去）。
 *
 * @param order 总线处理顺序（拓扑序）
 * @param blockParams 本块的逐帧自动化参数
 * @param overrides 运行期总线参数覆盖
 * @param frames 本块帧数
 * @returns 长度 = frames 的标志数组（1 = 该帧有总线在独奏）
 */
export function soloFlagsOf(
  order: readonly BusRuntime[],
  blockParams: ReadonlyMap<BusId, BlockParams>,
  overrides: ReadonlyMap<BusId, BusParamsPatch>,
  frames: number,
): Uint8Array {
  /** 逐帧是否存在独奏：逐帧变化，因此主循环不能只看一个块级标志 */
  const soloFlags = new Uint8Array(frames);
  for (let fr = 0; fr < frames; fr++) {
    for (const bus of order) {
      if (bus.id === MASTER_BUS) continue;
      const patch = overrides.get(bus.id) ?? {};
      const p = blockParams.get(bus.id);
      const solo =
        patch.solo ?? (p ? p.solo[fr] === 1 : (bus.spec.solo ?? false));
      if (solo) {
        soloFlags[fr] = 1;
        break;
      }
    }
  }
  return soloFlags;
}
