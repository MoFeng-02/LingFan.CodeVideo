import type { FrameIndex, Ms } from "@lingfan-video/contracts";

/** 帧号 → 时间戳：恒等式乘法，禁逐帧累加 */
export function timestampAt(frameIndex: FrameIndex, fps: number): Ms {
  return (frameIndex * 1000) / fps;
}

/** 时长毫秒 → 帧数（向下取整；尾帧不足一帧不渲染） */
export function msToFrames(ms: Ms, fps: number): number {
  return Math.floor((ms * fps) / 1000);
}

/** 帧数 → 时长毫秒 */
export function framesToMs(frames: number, fps: number): Ms {
  return (frames * 1000) / fps;
}

/** 总帧数（渲染循环上界） */
export function frameCount(durationMs: Ms, fps: number): number {
  return msToFrames(durationMs, fps);
}
