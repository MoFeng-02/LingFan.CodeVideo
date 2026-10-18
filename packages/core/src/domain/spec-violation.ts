/** 契约违约（与引擎其它 spec_violation 同一命名纪律：message 前缀 + Error.name） */
export function violation(message: string): Error {
  const err = new Error(`spec_violation: ${message}`);
  err.name = "SpecViolation";
  return err;
}
