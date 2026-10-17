import type { Ms, RenderError } from "@lingfan-video/contracts";

export type RenderErrorKind = RenderError["kind"];

/** RenderError 工厂：结构化错误进契约 */
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
