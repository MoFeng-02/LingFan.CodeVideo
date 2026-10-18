/**
 * DSP 内核的数值小工具：静音阈值、一阶平滑系数、摆位与环形取样。
 *
 * 全部为纯函数、不持有状态；采样率一律由调用方显式传入（Hz），时间参数一律为毫秒，
 * 避免内核内部混用「秒 / 帧」两种时间单位。
 */
import type { Ms } from "@lingfan-video/contracts";

/**
 * 线性幅度下限（约 -180 dBFS）：取对数（dB）前先夹到该值，避免 log10(0) 得到 -Infinity。
 * 低于此幅度的信号在检测器里等价于静音。
 */
const SILENT = 1e-9;

/**
 * 一阶低通平滑系数：把时间常数换算成每样本的历史保留比例。
 *
 * 用法：`env = coef * env + (1 - coef) * goal`。时间常数越短，coef 越小、跟得越快；
 * 压制器与压缩器的 attack/release 包络都走这里。
 *
 * @param ms 时间常数（毫秒）；≤ 0 表示不平滑，直接取目标值
 * @param sr 采样率（Hz），须 > 0
 * @returns 每样本保留比例（0..1；0 = 一步到位）
 */
function onePole(ms: Ms, sr: number): number {
  if (ms <= 0) return 0;
  return Math.exp((-1000 / ms) * (1 / sr));
}

/**
 * 摆位增益（线性律，非等功率）：只对输出声道为立体声时生效。
 *
 * 线性律 = 对侧声道按 |pan| 线性衰减，另一声道保持 1；因此 pan=0 时两声道都是 1，
 * 单声道源在立体声输出上响度不变。单声道/多声道输出不做摆位，恒返回 1。
 *
 * @param pan 声像位置 -1（全左）..1（全右）；越界按端点钳制
 * @param ch 目标声道序号：0 = 左声道，其余按右声道处理
 * @param outCh 输出声道数；≠ 2 时不做摆位
 * @returns 该声道的线性乘子（0..1）
 */
function panGain(pan: number, ch: number, outCh: number): number {
  if (outCh !== 2) return 1;
  const p = Math.max(-1, Math.min(1, pan));
  return ch === 0 ? 1 - Math.max(0, p) : 1 - Math.max(0, -p);
}

/**
 * 正模：把源内取样位置卷回 [0, n)，用于循环声音的回卷与负位置修正。
 *
 * JavaScript 的 `%` 对负数返回负值，这里补正一次；n ≤ 0（空源）时返回 0。
 *
 * @param v 源内位置（帧，可为负）
 * @param n 周期长度（源总帧数）
 * @returns 落在 [0, n) 内的位置
 */
function posMod(v: number, n: number): number {
  if (n <= 0) return 0;
  const m = v % n;
  return m < 0 ? m + n : m;
}

export { SILENT, onePole, panGain, posMod };
