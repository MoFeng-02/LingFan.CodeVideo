/** DSP 内核的数值小工具：静音阈值、一阶平滑系数、摆位与环形取样。 */
import type { Ms } from "@lingfan-video/contracts";

const SILENT = 1e-9;

/** 一阶平滑系数：时间常数 ms → 每样本保留比例（0 表示不平滑） */
function onePole(ms: Ms, sr: number): number {
  if (ms <= 0) return 0;
  return Math.exp((-1000 / ms) * (1 / sr));
}

/** 摆位增益（线性律）：非立体声输出恒 1 */
function panGain(pan: number, ch: number, outCh: number): number {
  if (outCh !== 2) return 1;
  const p = Math.max(-1, Math.min(1, pan));
  return ch === 0 ? 1 - Math.max(0, p) : 1 - Math.max(0, -p);
}

/** 正模：把源内取样位置卷回 [0, n) */
function posMod(v: number, n: number): number {
  if (n <= 0) return 0;
  const m = v % n;
  return m < 0 ? m + n : m;
}

export { SILENT, onePole, panGain, posMod };
