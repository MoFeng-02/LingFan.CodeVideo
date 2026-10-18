/**
 * 增益记法与幅度之间的唯一换算处（域层纯函数）。
 *
 * 作者可以写线性幅度（0.5）或分贝（{ db: -6 }）；平台侧只吃线性幅度，
 * 所以所有「用户可写的增益值」入口（gain 组合子、句柄 setGain、总线句柄 gain、
 * 自动化点）都在这里折算，别处不再出现 10^(db/20)。
 */
import type { GainLike } from "@lingfan-video/contracts";
import { violation } from "../spec-violation";

/**
 * 分贝 → 线性幅度：20·log10 的逆运算（-6 dB ≈ 0.501，+6 dB ≈ 1.995）。
 *
 * @param db 分贝值（有限数，可负）
 * @returns 线性幅度（正数）
 */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * 增益记法校验（静态校验与登记期共用这一处判据）。
 *
 * @param value 待校验值：线性幅度（≥0 的有限数）或 `{ db: 有限数 }`
 * @param name 用于报错定位的前缀（如 `gain`、`automation (music) 第 0 点 gain`）
 * @returns 问题文案；合法时为 null
 */
export function gainError(value: unknown, name: string): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0
      ? null
      : `${name}=${String(value)} 须为 ≥0 的有限数，或写 { db: number }`;
  }
  if (value !== null && typeof value === "object") {
    const db = (value as { readonly db?: unknown }).db;
    return typeof db === "number" && Number.isFinite(db)
      ? null
      : `${name} 的 db=${String(db)} 须为有限数`;
  }
  return `${name}=${String(value)} 须为 ≥0 的有限数，或写 { db: number }`;
}

/**
 * 把作者写的增益记法折算成线性幅度。
 *
 * @param value 增益记法：线性幅度或 `{ db }`
 * @param name 只用于报错定位的字段名
 * @returns 线性幅度（正数）
 * @throws SpecViolation 记法非法时（消息即 gainError 的文案）
 */
export function toLinearGain(value: GainLike, name: string): number {
  const problem = gainError(value, name);
  if (problem !== null) throw violation(problem);
  return typeof value === "number" ? value : dbToLinear(value.db);
}
