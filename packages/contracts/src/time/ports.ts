import type { FrameIndex, Ms } from "../shared/units";

/**
 * 时间层能力契约。
 *
 * 语义承诺（实现方必须满足）：
 * - timestampAt(frameIndex, fps) = frameIndex * (1000 / fps)——逐帧乘法，禁累加
 * - 导出端装配确定性时间线实现；预览端可换实时实现
 */
export interface Clock {
  t: Ms;
  frameIndex: FrameIndex;
  totalTime: Ms;
  fps: number;
  deltaTime: Ms;
}
