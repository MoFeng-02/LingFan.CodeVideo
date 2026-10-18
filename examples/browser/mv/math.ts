/**
 * 本片共用的确定性数学：区间进度、缓动、整数散列。
 *
 * 两条纪律：
 * 1. 全部纯函数、无状态——同入参同结果，重复渲染逐像素一致；
 * 2. `hash32` 是"按索引随机访问"的唯一入口：塔高、窗位、星位都由它算，
 *    因此画面结构不依赖帧序（30fps 与 60fps 段落的塔是同一批塔）。
 */

/** 夹到 [0,1]。 */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 夹到 [lo,hi]。 */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 线性插值。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** t 在 [a,b] 内的归一化进度（区间外夹到 0/1）。 */
export function span(t: number, a: number, b: number): number {
  return b <= a ? (t >= a ? 1 : 0) : clamp01((t - a) / (b - a));
}

/** 平滑进出：用于一切"从无到有"的淡入。 */
export function smoothstep(a: number, b: number, x: number): number {
  const p = span(x, a, b);
  return p * p * (3 - 2 * p);
}

/** 先慢后快：崩解下落、收束。 */
export function easeInQuad(p: number): number {
  const q = clamp01(p);
  return q * q;
}

/** 先快后慢：塔拔起。 */
export function easeOutCubic(p: number): number {
  const q = clamp01(p);
  return 1 - (1 - q) ** 3;
}

/** 两头慢中间快：收束、归位。 */
export function easeInOutCubic(p: number): number {
  const q = clamp01(p);
  return q < 0.5 ? 4 * q ** 3 : 1 - (-2 * q + 2) ** 3 / 2;
}

/** 可见窗 [from,to] 的淡入淡出透明度（默认入场 360ms、出场 420ms）。 */
export function fadeWindow(
  t: number,
  from: number,
  to: number,
  fadeIn = 360,
  fadeOut = 420,
): number {
  return Math.min(
    smoothstep(from, from + fadeIn, t),
    1 - smoothstep(to - fadeOut, to, t),
  );
}

/**
 * 整数散列 → [0,1)（32 位混洗，双轮消除低位规律）。
 * 与调用顺序无关：同一 n 永远同一值。这是"不靠随机流也能得到稳定布局"的地基。
 */
export function hash32(n: number): number {
  let x = Math.imul(n | 0, 0x9e3779b1) | 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) | 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) | 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** 由散列取区间值：[a,b] 内的确定性随机数。 */
export function hashRange(n: number, a: number, b: number): number {
  return a + (b - a) * hash32(n);
}
