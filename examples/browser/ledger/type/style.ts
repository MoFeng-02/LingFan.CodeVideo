/**
 * 仪器面的样式与几何：色板、字体、文字落位、刻度尺坐标、时间码。
 * 只给 `type/` 里的几块面板用，不含任何按时间反查镜头的逻辑。
 */
import type { Ms } from "@lingfan-video/contracts";
export const FONT = `"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
export const MONO = `"JetBrains Mono", "Cascadia Mono", Consolas, monospace`;

export const C = {
  bg: "#05070c",
  ink: "#f2f6ff",
  dim: "#93a4c4",
  ice: "#a8beff",
  brand: "#4d6bfe",
  warm: "#ffc778",
};

/** 刻度尺的左右端点与高度 */
export const RULER = { x0: 40, x1: 600, y: 318 };

/** 主读数块的左边界 */
export const HERO_X = 56;

export interface TextStyle {
  readonly size: number;
  readonly weight?: number;
  readonly color?: string;
  readonly alpha?: number;
  readonly tracking?: number;
  readonly align?: "left" | "center" | "right";
  readonly mono?: boolean;
}

/** 逐字绘制（为了字距）并返回整行宽度 */
export function write(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: TextStyle,
): number {
  g.save();
  g.globalAlpha = style.alpha ?? 1;
  g.fillStyle = style.color ?? C.ink;
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.font = `${style.weight ?? 400} ${style.size}px ${style.mono ? MONO : FONT}`;
  const tracking = style.tracking ?? 0;
  const chars = [...text];
  const widths = chars.map((ch) => g.measureText(ch).width);
  const total =
    widths.reduce((a, b) => a + b, 0) +
    tracking * Math.max(0, chars.length - 1);
  let cursor =
    style.align === "center"
      ? x - total / 2
      : style.align === "right"
        ? x - total
        : x;
  chars.forEach((ch, i) => {
    g.fillText(ch, cursor, y);
    cursor += widths[i]! + tracking;
  });
  g.restore();
  return total;
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function span(t: Ms, from: Ms, to: Ms): number {
  if (to <= from) return t >= from ? 1 : 0;
  return clamp01((t - from) / (to - from));
}

export function smooth(v: number): number {
  const p = clamp01(v);
  return p * p * (3 - 2 * p);
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 时间码 mm:ss.d：时刻由引擎给，这里只负责写出来 */
export function timeCode(ms: Ms): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60_000);
  const s = Math.floor((total % 60_000) / 1_000);
  const d = Math.floor((total % 1_000) / 100);
  return `${pad2(m)}:${pad2(s)}.${d}`;
}

/** 刻度尺下的分钟:秒标签，例如 0:10、1:30 */
export function rulerLabel(ms: Ms): string {
  const s = Math.round(ms / 1_000);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** 刻度尺上放得下的短代号 */
export function shortCode(code: string): string {
  const table: Record<string, string> = {
    V3: "V3",
    R1: "R1",
    "V3-0324": "0324",
    "R1-0528": "0528",
    "V3.1": "V3.1",
    "V3.1-Terminus": "T",
    "V3.2-Exp": "V3.2E",
    "V3.2": "V3.2",
    V4: "V4",
    "V4-Flash / V4-Pro": "F/P",
    "V4.1-Flash": "V4.1",
    "V4.1-Flash-1017": "1017",
  };
  return table[code] ?? code;
}

/** 把毫秒摆到刻度尺上；总长由引擎给（`state.totalTime`），不由剧本预设 */
export function rulerX(ms: Ms, totalTime: Ms): number {
  const span = RULER.x1 - RULER.x0;
  if (!(totalTime > 0)) return RULER.x0;
  return RULER.x0 + (span * ms) / totalTime;
}

/** 落版的淡出：末段里从 out 起收 */
