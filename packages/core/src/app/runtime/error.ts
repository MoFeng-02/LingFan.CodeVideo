/**
 * 渲染错误工厂：把「错在什么类别、哪个场景、哪一刻」收进契约的 RenderError。
 *
 * 引擎内部失败统一塑形为 RenderError 后再抛出，调用方可以按 `kind` 分流，
 * 并拿到出错时刻的时间线毫秒（`cursor`）来定位剧本位置。
 */
import type { Ms, RenderError } from "@lingfan-video/contracts";

/** RenderError 的错误类别（契约枚举）：spec_violation 违反契约语义 / window_overflow 帧窗池超支 / step_throw 回调抛错 / spawn_crash spawn 场景崩溃 */
export type RenderErrorKind = RenderError["kind"];

/**
 * 构造一个 RenderError（只塑形，不抛出）。
 *
 * @param kind 错误类别，决定调用方的处理路径
 * @param sceneId 出错所属场景 id；不属于具体场景时用 "engine"、"input"、"audio" 等内部标识
 * @param cursor 出错时刻的时间线毫秒（尚未开始求值时取 0）
 * @param message 面向人的错误描述
 * @param expected 期望值（可选，仅在有对照值时填，便于诊断）
 * @param actual 实际值（可选，仅在有对照值时填，便于诊断）
 * @returns 带 `kind` / `sceneId` / `cursor` 等契约字段的 Error 实例
 */
export function makeRenderError(
  kind: RenderErrorKind,
  sceneId: string,
  cursor: Ms,
  message: string,
  expected?: unknown,
  actual?: unknown,
): RenderError {
  const err = new Error(message) as RenderError;
  err.kind = kind;
  err.sceneId = sceneId;
  err.cursor = cursor;
  if (expected !== undefined) err.expected = expected;
  if (actual !== undefined) err.actual = actual;
  return err;
}
