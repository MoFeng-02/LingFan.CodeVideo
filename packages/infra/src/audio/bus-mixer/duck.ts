/** 侧链压制：按来源总线输出包络生成每帧一个的乘子。 */
import type { DuckRule } from "@lingfan-video/contracts";
import { SILENT, onePole } from "./dsp";

/** 侧链压制增益（每帧一个乘子）：来源输出包络 → 超阈值按 amountDb 压低，attack/hold/release 平滑 */
function computeDuckGain(
  from: Float32Array,
  rule: DuckRule,
  sr: number,
  ch: number,
  frames: number,
): Float32Array {
  const attack = onePole(rule.attackMs ?? 10, sr);
  const release = onePole(rule.releaseMs ?? 200, sr);
  const holdSamples = Math.max(0, Math.round(((rule.holdMs ?? 0) / 1000) * sr));
  const threshold = rule.thresholdDb ?? -30;
  const out = new Float32Array(frames);
  let env = 0;
  let cur = 0; // 当前压制量（dB）
  let hold = 0;
  for (let fr = 0; fr < frames; fr++) {
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const v = Math.abs(from[fr * ch + c] ?? 0);
      if (v > peak) peak = v;
    }
    const coef = peak > env ? attack : release;
    env = coef * env + (1 - coef) * peak;
    const db = 20 * Math.log10(Math.max(env, SILENT));
    const active = db > threshold;
    let target = active
      ? rule.amountDb * Math.min(1, (db - threshold) / 12)
      : 0;
    if (active) hold = holdSamples;
    else if (hold > 0) {
      hold--;
      target = cur; // 保持期：维持当前压制量
    }
    const coeff = target > cur ? attack : release;
    cur = coeff * cur + (1 - coeff) * target;
    out[fr] = 10 ** (-cur / 20);
  }
  return out;
}

export { computeDuckGain };
