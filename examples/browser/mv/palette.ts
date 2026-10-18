/**
 * 全片色板与字体族。所有绘制代码只许引用这里，禁止在画面代码里写死色值。
 * 色板本身是剧本的一部分：`dawn` 只在 28.0s 之后出现（水面之上的天光）。
 */
export const C = {
  abyss: "#04070d",
  deep: "#071528",
  mid: "#0b2340",
  brand: "#4d6bfe",
  ice: "#9db8ff",
  ink: "#edf2ff",
  dim: "#7c8fb8",
  dawn: "#ffc978",
} as const;

/** 字体族：只用系统字体。不加载 Web 字体——不联网、不引入跨机器像素差异。 */
export const FONT =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif';

/** `#rrggbb` → 0–255 三元组。 */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 十六进制色 + 透明度 → Canvas 认识的 rgba() 字符串。 */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 两色线性插值（t=0 取 a，t=1 取 b），返回 `#rrggbb`。 */
export function mixHex(a: string, b: string, t: number): string {
  const p = t < 0 ? 0 : t > 1 ? 1 : t;
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  let out = "#";
  for (let i = 0; i < 3; i++) {
    const v = Math.round(ca[i]! + (cb[i]! - ca[i]!) * p);
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}
