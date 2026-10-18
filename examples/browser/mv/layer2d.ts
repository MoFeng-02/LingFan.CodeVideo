/**
 * 二维文字层：字幕、标题、优势卡、落版。
 *
 * 它是**独立的一块 2D 画布**，由合成器和三维层叠在一起——不是"贴在三维上"，
 * 而是两个不同后端各交一张图，合成器按 `z` 叠。换合成器（CPU `drawImage`
 * 或 GPU 四边形）都不用改这里。
 */
import type { FrameIndex, Ms } from "@lingfan-video/contracts";
import type { LayerSurface } from "@lingfan-video/infra";
import { C, FONT, rgba } from "./palette";
import { clamp01, smoothstep } from "./math";
import { whalePath } from "./whale-mark";
import {
  ACTS,
  CARDS,
  DESIGN,
  END_CARD,
  SONG_END,
  TOTAL,
  actOf,
} from "./timeline";

const MONO = '"Consolas", "Cascadia Mono", ui-monospace, monospace';
const SANS =
  FONT ?? '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

function text(
  g: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  opts: {
    size: number;
    weight?: number;
    color?: string;
    alpha?: number;
    align?: CanvasTextAlign;
    font?: string;
    tracking?: number;
  },
): void {
  if (opts.alpha !== undefined && opts.alpha <= 0.004) return;
  g.save();
  g.globalAlpha = opts.alpha ?? 1;
  g.fillStyle = opts.color ?? C.ink;
  g.textAlign = opts.align ?? "left";
  g.font = `${opts.weight ?? 400} ${opts.size}px ${opts.font ?? SANS}`;
  if (opts.tracking) {
    // 逐字拉开字距：canvas 没有 letterSpacing，手动排
    const chars = Array.from(value);
    const widths = chars.map((ch) => g.measureText(ch).width + opts.tracking!);
    const total = widths.reduce((a, b) => a + b, 0) - opts.tracking!;
    let cx =
      opts.align === "center"
        ? x - total / 2
        : opts.align === "right"
          ? x - total
          : x;
    for (const [i, ch] of chars.entries()) {
      g.fillText(ch, cx, y);
      cx += widths[i]!;
    }
  } else {
    g.fillText(value, x, y);
  }
  g.restore();
}

/** 一行右对齐的小刻度：让画面有"编辑部"的节奏，不抢主体 */
function ticker(
  g: CanvasRenderingContext2D,
  index: number,
  t: number,
  pulse: number,
): void {
  const label = String(index + 1).padStart(2, "0");
  text(
    g,
    `${label} / ${String(ACTS.length).padStart(2, "0")}`,
    DESIGN.width - 26,
    26,
    {
      size: 8,
      color: rgba(C.dim, 0.55 + pulse * 0.35),
      align: "right",
      font: MONO,
    },
  );
  text(g, `${(t / 1000).toFixed(2)}s`, DESIGN.width - 26, 38, {
    size: 8,
    color: rgba(C.dim, 0.32),
    align: "right",
    font: MONO,
  });
}

/** 字幕：出字 + 淡出；标题比字幕大一号，只在前半段停留 */
function caption(g: CanvasRenderingContext2D, t: number): void {
  const act = actOf(t);
  const inT = smoothstep(act.from + 80, act.from + 340, t);
  const outT = 1 - smoothstep(act.to - 420, act.to - 60, t);
  const a = clamp01(inT * outT);
  if (a <= 0.01) return;

  // 字幕底：一条极淡的暗带，保证在亮背景上也读得动
  const grad = g.createLinearGradient(0, 268, 0, 332);
  grad.addColorStop(0, "rgba(3,6,12,0)");
  grad.addColorStop(0.55, `rgba(3,6,12,${0.42 * a})`);
  grad.addColorStop(1, "rgba(3,6,12,0)");
  g.fillStyle = grad;
  g.fillRect(0, 268, DESIGN.width, 64);

  text(g, act.caption, DESIGN.width / 2, 312, {
    size: 15,
    weight: 400,
    color: C.ink,
    alpha: a,
    align: "center",
    tracking: 0.6,
  });

  if (act.title) {
    const ta =
      a * (0.55 + 0.45 * smoothstep(act.from + 200, act.from + 900, t));
    text(g, act.title, DESIGN.width / 2, 62, {
      size: 22,
      weight: 600,
      color: C.ice,
      alpha: ta * 0.92,
      align: "center",
      tracking: 1.2,
    });
    // 标题下方一条短线，随节拍伸长
    const w = 36 + 18 * Math.sin((t - act.from) / (Math.PI * 2));
    g.globalAlpha = ta * 0.5;
    g.fillStyle = rgba(C.brand, 0.9);
    g.fillRect(DESIGN.width / 2 - w / 2, 70, w, 1);
    g.globalAlpha = 1;
  }
}

/** 优势卡：四张，各压在一段上；卡内元素错峰入场 */
function cards(g: CanvasRenderingContext2D, t: number): void {
  const card = CARDS.find((c) => t >= c.from && t < c.to);
  if (!card) return;
  const inA = smoothstep(card.from + 120, card.from + 420, t);
  const outA = 1 - smoothstep(card.to - 360, card.to - 60, t);
  const a = clamp01(inA * outA);
  if (a <= 0.01) return;

  g.save();
  g.globalAlpha = a * 0.86;
  g.fillStyle = "rgba(4,9,18,0.92)";
  g.beginPath();
  g.roundRect(64, 84, 512, 150, 7);
  g.fill();
  g.globalAlpha = a;
  g.strokeStyle = rgba(C.ice, 0.16);
  g.lineWidth = 0.7;
  g.stroke();
  g.restore();

  const dx = (1 - inA) * 10;
  text(g, card.kicker, 88 - dx, 110, {
    size: 9,
    color: rgba(C.brand, 0.95),
    alpha: a,
    font: MONO,
  });
  text(g, card.headline, 88 - dx, 148, {
    size: 26,
    weight: 600,
    color: C.ink,
    alpha: a,
  });
  text(g, card.detail, 88 - dx, 174, {
    size: 11.5,
    color: rgba(C.ice, 0.8),
    alpha: a,
  });

  // 编号 + 进度点
  const index = CARDS.indexOf(card);
  for (let i = 0; i < CARDS.length; i += 1) {
    g.globalAlpha = a;
    g.fillStyle = rgba(i === index ? C.ink : C.dim, i === index ? 0.85 : 0.22);
    g.fillRect(88 + i * 12, 210, i === index ? 9 : 5, 1.6);
  }
  g.globalAlpha = 1;

  glyph(g, card.glyph, 486, 150, a);
}

function glyph(
  g: CanvasRenderingContext2D,
  kind: "weights" | "activations" | "context" | "price",
  cx: number,
  cy: number,
  a: number,
): void {
  g.save();
  g.globalAlpha = a;
  if (kind === "weights") {
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const on = (i + j) % 3 === 0;
        g.fillStyle = rgba(on ? C.brand : C.ice, on ? 0.9 : 0.2);
        g.fillRect(cx - 40 + i * 22, cy - 24 + j * 18, 15, 11);
      }
    }
  } else if (kind === "activations") {
    g.fillStyle = rgba(C.dim, 0.28);
    g.fillRect(cx - 62, cy - 24, 124, 10);
    g.fillStyle = rgba(C.brand, 0.9);
    g.fillRect(cx - 62, cy + 14, 12, 10);
    text(g, "552B", cx - 62, cy - 30, {
      size: 7.5,
      color: rgba(C.ice, 0.65),
      font: MONO,
    });
    text(g, "8B", cx - 62, cy + 34, {
      size: 7.5,
      color: rgba(C.ice, 0.65),
      font: MONO,
    });
  } else if (kind === "context") {
    g.strokeStyle = rgba(C.ice, 0.28);
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(cx - 62, cy);
    g.lineTo(cx + 62, cy);
    g.stroke();
    for (let i = 0; i <= 12; i += 1) {
      const x = cx - 62 + (124 * i) / 12;
      const tall = i % 4 === 0;
      g.strokeStyle = rgba(
        i / 12 < 0.66 ? C.brand : C.ice,
        i / 12 < 0.66 ? 0.85 : 0.22,
      );
      g.beginPath();
      g.moveTo(x, cy - (tall ? 8 : 3.5));
      g.lineTo(x, cy + (tall ? 8 : 3.5));
      g.stroke();
    }
    text(g, "1M", cx + 62, cy - 14, {
      size: 8,
      color: rgba(C.ink, 0.8),
      align: "right",
      font: MONO,
    });
  } else {
    // 价格：四根递减的竖条 + 一个 4
    for (let i = 0; i < 4; i += 1) {
      const h = 34 - i * 7;
      g.fillStyle = rgba(i === 0 ? C.brand : C.ice, i === 0 ? 0.9 : 0.25);
      g.fillRect(cx - 46 + i * 20, cy + 18 - h, 11, h);
    }
    text(g, "4 元 / 百万", cx + 44, cy + 6, {
      size: 9,
      color: rgba(C.ink, 0.85),
      align: "left",
      font: MONO,
    });
  }
  g.restore();
}

/** 落版：环 + 名字 + 一行版本 + 一句叙事 */
function endCard(g: CanvasRenderingContext2D, t: number): void {
  if (t < END_CARD.from) return;
  const p = smoothstep(END_CARD.from, END_CARD.from + 700, t);
  // 底：把三维画面压暗，字才立得住
  g.globalAlpha = 0.45 * p;
  g.fillStyle = "#03060c";
  g.fillRect(0, 0, DESIGN.width, DESIGN.height);
  g.globalAlpha = 1;

  const { x, y, r } = END_CARD.ring;
  g.save();
  g.globalAlpha = p * 0.9;
  g.strokeStyle = rgba(C.brand, 0.75);
  g.lineWidth = 0.9;
  g.beginPath();
  g.arc(x, y, r * (0.9 + 0.1 * p), 0, Math.PI * 2);
  g.stroke();
  g.restore();

  // 环里那枚记号：与片头同一支笔画的鲸，缩到环心
  g.save();
  g.globalAlpha = p * 0.95;
  g.fillStyle = C.ink;
  whalePath(g, x + 2, y + 1, 0.3);
  g.fill();
  g.restore();

  const wordA = smoothstep(END_CARD.wordmarkAt, END_CARD.wordmarkAt + 500, t);
  text(g, END_CARD.wordmark, DESIGN.width / 2, y + 62, {
    size: 30,
    weight: 600,
    color: C.ink,
    alpha: wordA,
    align: "center",
    tracking: 0.8,
  });
  const lineA = smoothstep(END_CARD.lineAt, END_CARD.lineAt + 500, t);
  text(g, END_CARD.line, DESIGN.width / 2, y + 88, {
    size: 12,
    color: rgba(C.ice, 0.85),
    alpha: lineA,
    align: "center",
    tracking: 0.4,
  });
  const slA = smoothstep(END_CARD.sloganAt, END_CARD.sloganAt + 600, t);
  text(g, END_CARD.slogan, DESIGN.width / 2, y + 118, {
    size: 14,
    color: rgba(C.ink, 0.92),
    alpha: slA,
    align: "center",
    tracking: 0.8,
  });

  // 收尾：一条极细的线从中间向两侧散去
  const fade = smoothstep(SONG_END, TOTAL - 200, t);
  g.globalAlpha = 0.35 * (1 - fade) + 0.1;
  g.fillStyle = rgba(C.brand, 0.9);
  g.fillRect(DESIGN.width / 2 - 80 + fade * 60, y + 138, 160 - fade * 120, 0.8);
  g.globalAlpha = 1;
}

function paint(g: CanvasRenderingContext2D, t: number, frame: number): void {
  // 节拍脉冲：每拍一下，给"刻度"和标题短线用
  const pulse = 0.5 + 0.5 * Math.cos(((t % 531.4) / 531.4) * Math.PI * 2);

  const act = actOf(t);
  const index = ACTS.indexOf(act);
  ticker(g, index, t, pulse);
  caption(g, t);
  cards(g, t);
  endCard(g, t);
  void frame;
}

/** 造二维文字层（独立画布，交给合成器叠；id 由剧本声明决定） */
export function createLayer2d(width: number, height: number): LayerSurface {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("二维文字层需要 2D 画布上下文");

  const surface: LayerSurface = {
    id: "type",
    width,
    height,
    canvas,
    render(_frame: FrameIndex, timestampMs: Ms) {
      // 清的是**整块画布**（设备像素），不是设计空间那 640×360：
      // 半透明的字层如果只清左上角一块，旧帧会一直留在右半边。
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      // 设计空间 640×360 → 实际尺寸
      const s = width / DESIGN.width;
      ctx.scale(s, s);
      paint(ctx, timestampMs, _frame);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
  };

  return surface;
}
