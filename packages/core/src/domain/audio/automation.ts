import type { BusAutomationSpec } from "@lingfan-video/contracts";
import { gainError } from "./gain-units";

/**
 * 声明式自动化点表的形式问题（一次报全，便于静态校验一次性提示）。
 * 登记期抛错与静态校验共用这一处判据：结构对象可被字面量直接构造，不能只靠构造期校验。
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

/** 登记期校验：首条问题即抛（错误名 SpecViolation，与契约违规同一出口） */
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
