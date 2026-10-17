/** 毫秒数（引擎内全部时间值的基本单位） */
export type Ms = number;

/** 帧号（0 起） */
export type FrameIndex = number;

/** 时间恒等式：t = frameIndex * (1000 / fps)，逐帧乘法、禁累加 */
export const MS_PER_SECOND = 1000;
