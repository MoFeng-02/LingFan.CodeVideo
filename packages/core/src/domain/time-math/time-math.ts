/**
 * 帧与时间的换算（域层纯函数）：毫秒是语义单位，帧号只是采样网格的下标。
 *
 * 所有换算都走恒等式乘法（帧号 × 1000 / fps）而不是逐帧累加：累加会累积浮点误差，
 * 长片尾部的时刻会漂。采样密度只决定网格疏密，不改变时间轴本身。
 */
import type { FrameIndex, Ms } from "@lingfan-video/contracts";

/**
 * 帧号 → 时间戳（毫秒）：恒等式乘法，禁逐帧累加。
 *
 * @param frameIndex 帧号（0 起）
 * @param fps 采样密度（帧/秒，须 > 0）
 * @returns 该帧对应的时刻（毫秒）
 */
export function timestampAt(frameIndex: FrameIndex, fps: number): Ms {
  return (frameIndex * 1000) / fps;
}

/**
 * 时长毫秒 → 完整帧数（向下取整）：尾帧不足一帧不渲染。
 *
 * @param ms 时长（毫秒，须 ≥0）
 * @param fps 采样密度（帧/秒，须 > 0）
 * @returns 完整帧数
 */
export function msToFrames(ms: Ms, fps: number): number {
  return Math.floor((ms * fps) / 1000);
}

/**
 * 帧数 → 时长毫秒（`timestampAt` 的逆向）。
 *
 * @param frames 帧数（≥0）
 * @param fps 采样密度（帧/秒，须 > 0）
 * @returns 对应的时长（毫秒）
 */
export function framesToMs(frames: number, fps: number): Ms {
  return (frames * 1000) / fps;
}

/**
 * 总帧数：渲染循环的上界（与 `msToFrames` 同口径，尾帧不足一帧不计）。
 *
 * @param durationMs 总时长（毫秒，须 ≥0）
 * @param fps 采样密度（帧/秒，须 > 0）
 * @returns 需要渲染的帧数
 */
export function frameCount(durationMs: Ms, fps: number): number {
  return msToFrames(durationMs, fps);
}
