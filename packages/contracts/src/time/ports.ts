import type { FrameIndex, Ms } from "../shared/units";

/**
 * 时间层能力契约。
 *
 * 语义承诺（实现方必须满足）：
 * - timestampAt(frameIndex, fps) = frameIndex * (1000 / fps)——逐帧乘法，禁累加
 * - 导出端装配确定性时间线实现；预览端可换实时实现
 */
export interface Clock {
  /** 当前时间线时刻（毫秒，全局坐标） */
  t: Ms;
  /** 当前采样点的帧号（0 起；变帧率下与 t 不是均匀映射） */
  frameIndex: FrameIndex;
  /** 整条时间线的总时长（毫秒） */
  totalTime: Ms;
  /** 当前采样点的有效帧率（帧/秒）：只决定采样密度，不改变时间语义 */
  fps: number;
  /** 当前采样步长（毫秒），= 1000 / fps */
  deltaTime: Ms;
}
