/**
 * 契约违约的构造出口：message 带 `spec_violation: ` 前缀，错误名为 `SpecViolation`。
 *
 * 全仓的「剧本写错了」都用这一条出口，因此调用方可以只认前缀/错误名，
 * 不必按文案分支。它只造错、不抛错，抛出时机由调用方决定。
 *
 * @param message 人读的违约说明（不含前缀）
 * @returns 已命名的 Error 实例
 */
export function violation(message: string): Error {
  const err = new Error(`spec_violation: ${message}`);
  err.name = "SpecViolation";
  return err;
}
