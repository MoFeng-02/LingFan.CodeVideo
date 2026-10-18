/** 侧链压制：按来源总线输出包络生成每帧乘子，状态跨块保留。 */
import type { DuckRule } from "@lingfan-video/contracts";
import { SILENT, onePole } from "./math";

class DuckUnit {
  private readonly attack: number;
  private readonly release: number;
  private readonly holdSamples: number;
  private readonly threshold: number;
  private env = 0;
  /** 当前压制量（dB） */
  private cur = 0;
  private hold = 0;

  constructor(
    private readonly rule: DuckRule,
    sr: number,
    private readonly ch: number,
  ) {
    this.attack = onePole(rule.attackMs ?? 10, sr);
    this.release = onePole(rule.releaseMs ?? 200, sr);
    this.holdSamples = Math.max(
      0,
      Math.round(((rule.holdMs ?? 0) / 1000) * sr),
    );
    this.threshold = rule.thresholdDb ?? -30;
  }

  /** 就地压制目标块：来源块必须是本块已算出的输出 */
  apply(target: Float32Array, from: Float32Array, frames: number): void {
    for (let fr = 0; fr < frames; fr++) {
      let peak = 0;
      for (let c = 0; c < this.ch; c++) {
        const v = Math.abs(from[fr * this.ch + c] ?? 0);
        if (v > peak) peak = v;
      }
      const coef = peak > this.env ? this.attack : this.release;
      this.env = coef * this.env + (1 - coef) * peak;
      const db = 20 * Math.log10(Math.max(this.env, SILENT));
      const active = db > this.threshold;
      let goal = active
        ? this.rule.amountDb * Math.min(1, (db - this.threshold) / 12)
        : 0;
      if (active) this.hold = this.holdSamples;
      else if (this.hold > 0) {
        this.hold--;
        goal = this.cur; // 保持期：维持当前压制量
      }
      const coeff = goal > this.cur ? this.attack : this.release;
      this.cur = coeff * this.cur + (1 - coeff) * goal;
      const g = 10 ** (-this.cur / 20);
      for (let c = 0; c < this.ch; c++) {
        const i = fr * this.ch + c;
        target[i] = target[i]! * g;
      }
    }
  }
}

export { DuckUnit };
