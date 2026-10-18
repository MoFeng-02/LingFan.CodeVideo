/** 声音求值模块内的小工具：区间裁剪与规约错误构造。 */

/**
 * 数值钳制到 [min, max]。
 *
 * @param v 待钳制的值
 * @param min 下界
 * @param max 上界
 * @returns 钳制后的值（先按 min 判断，再按 max 判断）
 */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * 契约违约错误（名称与出片端其它校验点一致：SpecViolation）。
 *
 * @param message 具体原因（不含前缀，前缀由本函数补）
 * @returns name 为 "SpecViolation" 的 Error
 */
function specViolation(message: string): Error {
  const err = new Error(`spec_violation: ${message}`);
  err.name = "SpecViolation";
  return err;
}

export { clamp, specViolation };
