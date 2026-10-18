/**
 * 程序化音源的形式判据。
 *
 * 登记期抛错与静态校验共用这一处：结构对象可被字面量直接构造，
 * 因此不能只靠组合子构造时的校验。一次报全全部问题。
 */
import type { SynthSpec } from "@lingfan-video/contracts";

/**
 * 程序化音源的形式问题（一次报全，便于静态校验一次性提示）。
 * 登记期抛错与静态校验共用这一处判据：结构对象可被字面量直接构造，不能只靠构造期校验。
 */
/**
 * 列出音源规格的全部形式问题（空数组 = 合法）。
 *
 * 检查项：`durationMs` 为 > 0 的有限数；非噪声波形时 `freq` > 0；`detune` 有限；
 * `gain` ≥ 0；`pan` 在 [-1, 1]；`seed` 有限（按 32 位无符号取用）；
 * 包络的 attack/decay/release ≥ 0 且 `sustain` 在 [0, 1]。
 *
 * @param spec 音源规格（波形/时长/频率/包络/总线）
 * @returns 问题文案列表
 */
export function synthErrors(spec: SynthSpec): string[] {
  const errors: string[] = [];
  const tag = `synth (${spec.wave})`;
  if (!(spec.durationMs > 0) || !Number.isFinite(spec.durationMs))
    errors.push(`${tag} durationMs=${spec.durationMs} 须为 > 0 的有限数`);
  if (
    spec.wave !== "noise" &&
    (!(spec.freq > 0) || !Number.isFinite(spec.freq))
  )
    errors.push(`${tag} freq=${spec.freq} 须为 > 0 的有限数（噪声波形除外）`);
  if (spec.detune !== undefined && !Number.isFinite(spec.detune))
    errors.push(`${tag} detune=${spec.detune} 须为有限数`);
  if (
    spec.gain !== undefined &&
    (!(spec.gain >= 0) || !Number.isFinite(spec.gain))
  )
    errors.push(`${tag} gain=${spec.gain} 须为 ≥0 的有限数`);
  if (
    spec.pan !== undefined &&
    (!(Math.abs(spec.pan) <= 1) || !Number.isFinite(spec.pan))
  )
    errors.push(`${tag} pan=${spec.pan} 须在 [-1, 1]`);
  if (spec.seed !== undefined && !Number.isFinite(spec.seed))
    errors.push(`${tag} seed=${spec.seed} 须为有限数（按 32 位无符号取用）`);
  const env = spec.envelope;
  if (env) {
    for (const key of ["attackMs", "decayMs", "releaseMs"] as const) {
      const v = env[key];
      if (!(v >= 0) || !Number.isFinite(v))
        errors.push(`${tag} envelope.${key}=${v} 须为 ≥0 的有限数`);
    }
    if (!(env.sustain >= 0 && env.sustain <= 1))
      errors.push(`${tag} envelope.sustain=${env.sustain} 须在 [0, 1]`);
  }
  return errors;
}

/**
 * 登记期校验：首条问题即抛，错误名为 SpecViolation（与契约违规同一出口）。
 *
 * @param spec 音源规格
 * @throws SpecViolation 任一形式问题存在时（消息为第一条问题）
 */
export function assertSynth(spec: SynthSpec): void {
  const first = synthErrors(spec)[0];
  if (first === undefined) return;
  const err = new Error(`spec_violation: ${first}`);
  err.name = "SpecViolation";
  throw err;
}
