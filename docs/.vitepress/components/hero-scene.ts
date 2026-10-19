/**
 * 首页 hero 演示场景：三幕链「登记 → 推演 → 出片」。
 *
 * 零资产、零音频、无随机：每帧画面是 ctx.localT 的确定性函数，帧间用半透明
 * 底色把上一帧内容衰减成轨迹（纯函数，不依赖帧间可变状态）。幕间
 * transitionTo 重叠 OVERLAP_MS：重叠窗内前后两幕同帧求值、后一幕后绘制；
 * 总时长 = 窗口和 − 重叠 = 1700ms，由链编译得出，不在任何一处手工声明。
 *
 * 帧函数对画布做空值守卫：预览装配拿到真实画布，headless 推演（compute 取样）
 * 拿到 null——同一份剧本两种用法都能跑。
 */
import { createScene, start } from "@lingfan-video/core";

/** 演示画幅与帧率：预览装配与展示层从这里同源取用 */
export const HERO_FPS = 30;
export const HERO_WIDTH = 960;
export const HERO_HEIGHT = 360;

/** 幕窗口与重叠（毫秒）：场景定义与展示层进度条共用这一组常量 */
const ACT_MS = [600, 800, 600] as const;
const OVERLAP_MS = 150;

/** 三幕窗口之和（进度条分段宽度按它归一化） */
export const HERO_WINDOW_SUM = ACT_MS[0] + ACT_MS[1] + ACT_MS[2];

/** 每幕在总时间线上的落位：start = 前幕 start + 前幕窗 − 重叠 */
export const HERO_TIMELINE = [
  { id: "登记", start: 0, duration: ACT_MS[0] },
  { id: "推演", start: ACT_MS[0] - OVERLAP_MS, duration: ACT_MS[1] },
  { id: "出片", start: ACT_MS[0] + ACT_MS[1] - 2 * OVERLAP_MS, duration: ACT_MS[2] },
] as const;

/** 总时长 = 窗口和 − 重叠：链的编译产物，展示层只读它做换算 */
export const HERO_TOTAL = HERO_WINDOW_SUM - 2 * OVERLAP_MS;

const BRAND = "#4d6bfe";
const INK = "#e7ecf6";
const TRACK = "rgba(77, 107, 254, 0.4)";

/** 取幕画布的 2D 上下文；headless 推演（compute 取样）时 canvas 为 null，原样返回 null */
function surface(canvas: HTMLCanvasElement | OffscreenCanvas | null): CanvasRenderingContext2D | null {
  return (canvas?.getContext("2d") ?? null) as CanvasRenderingContext2D | null;
}

/** 帧间衰减：铺半透明底色，让上一帧内容衰减成轨迹 */
function veil(g: CanvasRenderingContext2D, alpha: number): void {
  g.fillStyle = `rgba(11, 16, 32, ${alpha})`;
  g.fillRect(0, 0, HERO_WIDTH, HERO_HEIGHT);
}

/** 品牌色光点：外圈光晕 + 实心核 */
function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.fillStyle = "rgba(77, 107, 254, 0.22)";
  g.beginPath();
  g.arc(x, y, r * 2.6, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = BRAND;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

/** 折到 0..1，供各幕把 progress 换成局部节奏 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 幕一「登记」：DSL 关键词从两侧收拢到中轴，落成时间轴 */
const ACT1_WORDS = ["step", "loop", "spawn", "wait"] as const;
function paintEnlist(g: CanvasRenderingContext2D, p: number): void {
  const ease = 1 - (1 - p) ** 3;
  const midY = HERO_HEIGHT / 2 - 24;
  ACT1_WORDS.forEach((word, i) => {
    const toX = HERO_WIDTH / 2 + (i - 1.5) * 130;
    const fromX = i % 2 === 0 ? -60 : HERO_WIDTH + 60;
    const fromY = 44 + (i % 3) * 38;
    const x = fromX + (toX - fromX) * ease;
    const y = fromY + (midY - fromY) * ease;
    dot(g, x, y, 5);
    g.globalAlpha = clamp01(ease * 1.4);
    g.fillStyle = INK;
    g.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textAlign = "center";
    g.fillText(word, x, y + 30);
    g.globalAlpha = 1;
  });
  if (p > 0.4) {
    const a = clamp01((p - 0.4) / 0.4);
    g.strokeStyle = TRACK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(80, midY + 68);
    g.lineTo(80 + (HERO_WIDTH - 160) * a, midY + 68);
    g.stroke();
  }
}

/** 幕二「推演」：扫描线推进，包络正弦随扫描逐渐成形 */
function paintSimulate(g: CanvasRenderingContext2D, p: number): void {
  const x0 = 80;
  const x1 = HERO_WIDTH - 80;
  const midY = HERO_HEIGHT / 2 - 24;
  const scanX = x0 + (x1 - x0) * p;
  g.strokeStyle = BRAND;
  g.lineWidth = 2;
  g.beginPath();
  for (let x = x0; x <= scanX; x += 4) {
    const u = (x - x0) / (x1 - x0);
    const y = midY + Math.sin(u * Math.PI * 4) * 56 * Math.sin(u * Math.PI);
    if (x === x0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  dot(g, scanX, midY + Math.sin(p * Math.PI * 4) * 56 * Math.sin(p * Math.PI), 6);
  g.strokeStyle = TRACK;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x0, midY + 68);
  g.lineTo(x1, midY + 68);
  g.stroke();
}

/** 幕三「出片」：帧块依次从扫描端飞入，堆成胶片格 */
const ACT3_SLOTS = 8;
function paintFrames(g: CanvasRenderingContext2D, p: number): void {
  const midY = HERO_HEIGHT / 2 - 24;
  const floorY = HERO_HEIGHT - 96;
  for (let i = 0; i < ACT3_SLOTS; i++) {
    const k = clamp01((p - i / ACT3_SLOTS) * 2.5);
    if (k <= 0) continue;
    const ease = 1 - (1 - k) ** 2;
    const toX = HERO_WIDTH / 2 + (i - (ACT3_SLOTS - 1) / 2) * 56;
    const x = HERO_WIDTH - 80 + (toX - (HERO_WIDTH - 80)) * ease;
    const y = midY + (floorY - midY) * ease;
    g.fillStyle = "rgba(77, 107, 254, 0.85)";
    g.fillRect(x - 20, y - 30, 40, 60);
    g.strokeStyle = "rgba(231, 236, 246, 0.3)";
    g.lineWidth = 1;
    g.strokeRect(x - 20, y - 30, 40, 60);
  }
}

/** 幕一（链头）：登记期只登记，不画任何一帧 */
const act1 = start(ACT_MS[0], (env) => {
  env.step(ACT_MS[0], (ctx) => {
    const g = surface(ctx.canvas);
    if (g) {
      veil(g, 0.55);
      paintEnlist(g, ctx.progress);
    }
    return { act: "登记", p: +ctx.progress.toFixed(2) };
  });
  env.transitionTo(act2, { overlapMs: OVERLAP_MS });
});

/** 幕二「推演」：重叠期与幕一尾帧同帧叠画（后一幕后绘制） */
const act2 = createScene(ACT_MS[1], (_prev, env) => {
  env.step(ACT_MS[1], (ctx) => {
    const g = surface(ctx.canvas);
    if (g) {
      veil(g, 0.35);
      paintSimulate(g, ctx.progress);
    }
    return { act: "推演", p: +ctx.progress.toFixed(2) };
  });
  env.transitionTo(act3, { overlapMs: OVERLAP_MS });
});

/** 幕三「出片」（链尾） */
const act3 = createScene(ACT_MS[2], (_prev, env) => {
  env.step(ACT_MS[2], (ctx) => {
    const g = surface(ctx.canvas);
    if (g) {
      veil(g, 0.4);
      paintFrames(g, ctx.progress);
    }
    return { act: "出片", p: +ctx.progress.toFixed(2) };
  });
});

/** 供预览装配直接推演的完整链头 */
export const heroScene = act1;
