/** 混音模块内的数值小工具：静音阈值、一阶平滑系数与等功率近似摆位。 */
import type { Ms } from "@lingfan-video/contracts";

const SILENT = 1e-9;

/** 一阶平滑系数：时间常数 ms → 每样本保留比例（0 表示不平滑） */
function onePole(ms: Ms, sr: number): number {
  if (ms <= 0) return 0;
  return Math.exp((-1000 / ms) * (1 / sr));
}

/** 摆位增益（与声音级同一近似：线性律） */
function panGain(pan: number, ch: number, outCh: number): number {
  if (outCh < 2) return 1;
  const p = Math.max(-1, Math.min(1, pan));
  return ch === 0 ? 1 - Math.max(0, p) : 1 - Math.max(0, -p);
}

export { SILENT, onePole, panGain };
