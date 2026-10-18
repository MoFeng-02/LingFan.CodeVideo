/**
 * 参数计划（自动化点表）的合法性判据。
 *
 * 判据与登记期抛错、静态校验共用一处：结构对象可被字面量直接构造，
 * 因此不能只靠组合子构造时的校验。一次报全全部问题，便于静态校验一次性提示。
 * 时刻单位是毫秒（相对本段起点），同一时刻重复没有先后可言，故要求严格递增。
 */
import type { BusAutomationSpec } from "@lingfan-video/contracts";
import { gainError } from "./gain-units";

/**
 * 声明式自动化点表的形式问题（一次报全，便于静态校验一次性提示）。
 * 登记期抛错与静态校验共用这一处判据：结构对象可被字面量直接构造，不能只靠构造期校验。
 */
/**
 * 列出参数计划的全部形式问题（空数组 = 合法）。
 *
 * 检查项：总线名非空、每个点 `atMs` 为 ≥0 的有限毫秒且严格递增、`gain` 记法合法、
 * `pan` 在 [-1, 1]、`rampMs` 为 ≥0 的有限毫秒。
 *
 * @param spec 参数计划（总线名 + 按时间排列的点）
 * @returns 问题文案列表（按点序；每项自带定位信息）
 */
export function automationErrors(spec: BusAutomationSpec): string[] {
  const errors: string[] = [];
  const tag = `automation (${spec.bus})`;
  if (typeof spec.bus !== "string" || spec.bus.length === 0)
    errors.push(`${tag} bus 不能为空`);
  let prevAt = -Infinity;
  spec.points.forEach((p, i) => {
    if (!isMs(p.atMs)) {
      errors.push(
        `${tag} 第 ${i} 点 atMs=${String(p.atMs)} 非法（须为 ≥0 的有限毫秒）`,
      );
    } else {
      // 计划按时间推进，重复时刻无先后可言
      if (p.atMs <= prevAt)
        errors.push(
          `${tag} 第 ${i} 点 atMs=${p.atMs} 未严格递增（前一点 ${prevAt}）`,
        );
      prevAt = p.atMs;
    }
    if (p.gain !== undefined) {
      const problem = gainError(p.gain, `${tag} 第 ${i} 点 gain`);
      if (problem !== null) errors.push(problem);
    }
    if (
      p.pan !== undefined &&
      (!(Math.abs(p.pan) <= 1) || !Number.isFinite(p.pan))
    )
      errors.push(`${tag} 第 ${i} 点 pan=${p.pan} 须在 [-1, 1]`);
    if (p.rampMs !== undefined && !isMs(p.rampMs))
      errors.push(`${tag} 第 ${i} 点 rampMs=${p.rampMs} 须为 ≥0 的有限毫秒`);
  });
  return errors;
}

/**
 * 登记期校验：首条问题即抛，错误名为 SpecViolation（与契约违规同一出口）。
 *
 * @param spec 参数计划
 * @throws SpecViolation 任一形式问题存在时（消息为第一条问题）
 */
export function assertAutomation(spec: BusAutomationSpec): void {
  const first = automationErrors(spec)[0];
  if (first === undefined) return;
  const err = new Error(`spec_violation: ${first}`);
  err.name = "SpecViolation";
  throw err;
}

/** 毫秒合法性：有限且非负 */
function isMs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
