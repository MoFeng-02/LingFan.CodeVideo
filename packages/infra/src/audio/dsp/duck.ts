/**
 * 侧链压制：按来源总线输出包络生成每帧乘子，状态跨块保留。
 *
 * 压制量（dB）由来源信号的峰值包络驱动：包络超过 thresholdDb 后按 amountDb 线性放大，
 * 再经 attack/release 一阶平滑成乘子 `g = 10^(-cur/20)`，就地乘到目标总线上。
 * 单位：时间参数为毫秒，amountDb/thresholdDb 为 dB（amountDb 为正数表示压多少）。
 */
import type { DuckRule } from "@lingfan-video/contracts";
import { SILENT, onePole } from "./math";

/** 一条侧链压制规则的有状态执行单元：包络与压制量都跨块保留，块尺寸不影响结果 */
class DuckUnit {
  /** 包络上升（attack）时的每样本保留比例（0..1） */
  private readonly attack: number;
  /** 包络回落（release）时的每样本保留比例（0..1） */
  private readonly release: number;
  /** 保持期的剩余样本数（holdMs 换算成输出帧数，块的边界不打断保持） */
  private readonly holdSamples: number;
  /** 触发压制的阈值（dBFS，缺省 -30） */
  private readonly threshold: number;
  /** 来源峰值的平滑包络（线性幅度） */
  private env = 0;
  /** 当前压制量（dB） */
  private cur = 0;
  private hold = 0;

  /**
   * @param rule 压制规则：来源/目标总线、压制量、attack/hold/release、阈值
   * @param sr 输出采样率（Hz），用于把毫秒换算成帧数
   * @param ch 输出声道数（来源与目标的声道布局一致）
   */
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

  /**
   * 就地压制目标块：来源块必须是本块已算出的输出。
   *
   * 处理顺序由总线拓扑保证（来源在目标之前）；只按样本乘增益，不改变声道布局。
   *
   * @param target 目标总线的块缓冲（就地修改，长度 ≥ frames × ch）
   * @param from 来源总线的块缓冲（只读，长度 ≥ frames × ch）
   * @param frames 本块帧数
   */
  apply(target: Float32Array, from: Float32Array, frames: number): void {
    for (let fr = 0; fr < frames; fr++) {
      /** 本帧来源各声道的峰值（线性幅度） */
      let peak = 0;
      for (let c = 0; c < this.ch; c++) {
        const v = Math.abs(from[fr * this.ch + c] ?? 0);
        if (v > peak) peak = v;
      }
      /** 包络跟随方向：上升走 attack，下降走 release */
      const coef = peak > this.env ? this.attack : this.release;
      this.env = coef * this.env + (1 - coef) * peak;
      const db = 20 * Math.log10(Math.max(this.env, SILENT));
      const active = db > this.threshold;
      /** 目标压制量（dB，正数）；按超出阈值的程度在 12 dB 内渐入 */
      let goal = active
        ? this.rule.amountDb * Math.min(1, (db - this.threshold) / 12)
        : 0;
      if (active) this.hold = this.holdSamples;
      else if (this.hold > 0) {
        this.hold--;
        goal = this.cur; // 保持期：维持当前压制量
      }
      /** 压制量本身的平滑系数（压制加深时走 attack） */
      const coeff = goal > this.cur ? this.attack : this.release;
      this.cur = coeff * this.cur + (1 - coeff) * goal;
      /** 本帧的线性乘子（≤ 1） */
      const g = 10 ** (-this.cur / 20);
      for (let c = 0; c < this.ch; c++) {
        const i = fr * this.ch + c;
        target[i] = target[i]! * g;
      }
    }
  }
}

export { DuckUnit };
