/** 逐帧状态包：step 回调产出、经 key 化聚合合并 */
import type { Ms } from "../shared/units";

export type FrameState = Record<string, unknown>;

/** 渲染错误：结构化、可编程消费 */
export interface RenderError extends Error {
  kind: "spec_violation" | "window_overflow" | "step_throw" | "spawn_crash";
  sceneId: string;
  cursor: Ms;
  expected?: unknown;
  actual?: unknown;
}

/** 剧本静态检查结果（validate 纯检查产出） */
export interface ValidationError {
  /** 违规位置，如 "scene#2/step#5" */
  path: string;
  code: string;
  message: string;
}
