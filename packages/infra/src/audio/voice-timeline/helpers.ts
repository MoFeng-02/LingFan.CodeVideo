/** 声音求值模块内的小工具：区间裁剪与规约错误构造。 */

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function specViolation(message: string): Error {
  const err = new Error(`spec_violation: ${message}`);
  err.name = "SpecViolation";
  return err;
}

export { clamp, specViolation };
