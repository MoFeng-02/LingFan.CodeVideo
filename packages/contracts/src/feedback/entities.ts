/** 反馈契约：逐帧状态、渲染错误与静态检查结果。 */
import type { Ms } from "../shared/units";

/** 逐帧状态包：step 回调产出、经 key 化聚合合并 */
export type FrameState = Record<string, unknown>;

/** 渲染错误：结构化、可编程消费 */
export interface RenderError extends Error {
  /** 错误种类：spec_violation = 违反契约语义；window_overflow = 帧窗池超支；step_throw = 回调抛错；spawn_crash = spawn 场景崩溃 */
  kind: "spec_violation" | "window_overflow" | "step_throw" | "spawn_crash";
  /** 出错场景的 id */
  sceneId: string;
  /** 出错时全局时间线游标（毫秒） */
  cursor: Ms;
  /** 相关期望值（如应有的窗口长度） */
  expected?: unknown;
  /** 相关实际值（如给出的窗口长度） */
  actual?: unknown;
}

/** 剧本静态检查结果（validate 纯检查产出） */
export interface ValidationError {
  /** 违规位置，如 "scene#2/step#5" */
  path: string;
  /** 机器可读的错误码 */
  code: string;
  /** 面向人的说明 */
  message: string;
}
