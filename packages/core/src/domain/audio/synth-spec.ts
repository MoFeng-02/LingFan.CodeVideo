import type { SynthSpec } from "@lingfan-video/contracts";

/**
 * 程序化音源的形式问题（一次报全，便于静态校验一次性提示）。
 * 登记期抛错与静态校验共用这一处判据：结构对象可被字面量直接构造，不能只靠构造期校验。
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

/** 登记期校验：首条问题即抛（错误名 SpecViolation，与契约违规同一出口） */
export function assertSynth(spec: SynthSpec): void {
  const first = synthErrors(spec)[0];
  if (first === undefined) return;
  const err = new Error(`spec_violation: ${first}`);
  err.name = "SpecViolation";
  throw err;
}
