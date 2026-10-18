/**
 * 仪器的常驻部分：顶栏（这是谁的记录、现在到哪）与底部刻度尺（十二枚版本印章）。
 * 刻度尺全片不走开，只有指针在动、印章在落——镜头之间靠它接住，不需要转场。
 */
import type { Ms } from "@lingfan-video/contracts";
import { SHOTS, STAMPS } from "../script";
import type { LedgerState } from "../program";
import { drawMark } from "../brand";
import { endCardFade } from "./endcard";
import {
  C,
  RULER,
  rulerLabel,
  shortCode,
  smooth,
  span,
  timeCode,
  write,
} from "./style";
export function paintTopBar(
  g: CanvasRenderingContext2D,
  state: LedgerState,
): void {
  const appear = smooth(span(state.t, 380, 1_100));
  if (appear <= 0) return;
  const alpha = appear * endCardFade(state);

  drawMark(g, 20, 8.5, {
    height: 8,
    color: C.ink,
    alpha: alpha * 0.55,
    whaleOnly: true,
  });
  write(g, "VERSION LOG", 35, 16.2, {
    size: 6.2,
    mono: true,
    color: C.dim,
    alpha: alpha * 0.9,
    tracking: 1.7,
  });
  write(g, "2024.12 — 2026.10", 35, 25.6, {
    size: 5.4,
    mono: true,
    color: C.dim,
    alpha: alpha * 0.6,
    tracking: 0.9,
  });

  write(g, `${timeCode(state.t)}`, RULER.x1, 16.2, {
    size: 6.2,
    mono: true,
    color: C.ink,
    alpha: alpha * 0.8,
    tracking: 0.9,
    align: "right",
  });
  write(g, `#${state.frameIndex}`, RULER.x1, 25.6, {
    size: 5.4,
    mono: true,
    color: C.dim,
    alpha: alpha * 0.55,
    tracking: 0.8,
    align: "right",
  });

  // 这一镜的采样密度：30 / 60 / 90 / 120 真的按镜给，不是全片一个数
  write(g, `采样 ${state.fps} FPS`, RULER.x1, 35.4, {
    size: 5.4,
    mono: true,
    color: C.ice,
    alpha: alpha * 0.62,
    tracking: 0.9,
    align: "right",
  });

  g.save();
  g.globalAlpha = alpha * 0.09;
  g.fillStyle = C.ink;
  g.fillRect(20, 38.5, RULER.x1 - 20, 0.5);
  g.restore();
}

/** 底部的走纸带：只画最近 24 秒，指针钉在右端——没有总长，只有"现在" */
const WINDOW_MS: Ms = 24_000;

export function paintRuler(
  g: CanvasRenderingContext2D,
  state: LedgerState,
): void {
  const alpha = endCardFade(state);
  if (alpha <= 0) return;
  const y = RULER.y;
  const width = RULER.x1 - RULER.x0;
  const from = Math.max(0, state.t - WINDOW_MS);
  const xOf = (ms: Ms): number => RULER.x0 + (width * (ms - from)) / WINDOW_MS;
  const head = xOf(state.t);

  g.save();
  g.globalAlpha = alpha * 0.92;
  g.lineCap = "butt";

  // 基线整条；已走的部分只是右侧一段
  g.strokeStyle = C.dim;
  g.globalAlpha = alpha * 0.32;
  g.lineWidth = 0.5;
  g.beginPath();
  g.moveTo(RULER.x0, y);
  g.lineTo(RULER.x1, y);
  g.stroke();

  g.globalAlpha = alpha * 0.55;
  g.strokeStyle = C.brand;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(RULER.x0, y);
  g.lineTo(head, y);
  g.stroke();

  // 刻度：500ms 短、5s 长；每 2s 标一枚时间码（绝对毫秒，跟着引擎走）
  const first = Math.ceil(from / 500) * 500;
  for (let ms = first; ms <= state.t; ms += 500) {
    const x = xOf(ms);
    const major = ms % 5_000 === 0;
    const minor = ms % 1_000 === 0;
    const h = major ? 4.6 : minor ? 2.8 : 1.6;
    g.globalAlpha = alpha * (major ? 0.3 : 0.16);
    g.strokeStyle = C.ink;
    g.lineWidth = 0.5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + h);
    g.stroke();
    if (ms > 0 && ms % 2_000 === 0) {
      write(g, rulerLabel(ms), x, y + 13, {
        size: 5,
        mono: true,
        color: C.dim,
        alpha: alpha * 0.5,
        tracking: 0.4,
        align: "center",
      });
    }
  }

  // 十二枚版本印章：槽位是版式，亮暗只看"这一版有没有出现"
  const passedCount = STAMPS.filter((stamp) => {
    const index = SHOTS.findIndex((shot) => shot.id === stamp.shot);
    return index >= 0 && state.order >= index;
  }).length;
  STAMPS.forEach((stamp, i) => {
    const x = RULER.x0 + width * ((i + 0.5) / STAMPS.length);
    const passed = i < passedCount;
    const current = passed && i === passedCount - 1;
    const row = i % 3;
    const labelY = y - 10 - row * 5.6;

    g.globalAlpha = alpha * (passed ? 0.95 : 0.22);
    g.strokeStyle = passed ? C.brand : C.ink;
    g.lineWidth = passed ? 1 : 0.5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + (passed ? 6.4 : 4));
    g.stroke();

    if (current) {
      g.globalAlpha = alpha * 0.9;
      g.fillStyle = C.warm;
      g.beginPath();
      g.arc(x, y + 8.4, 1.1, 0, Math.PI * 2);
      g.fill();
    }

    write(g, shortCode(stamp.code), x, labelY, {
      size: 5.4,
      mono: true,
      color: passed ? C.ink : C.dim,
      alpha: alpha * (passed ? 0.82 : 0.28),
      tracking: 0.4,
      align: "center",
    });
  });

  // 指针钉在右端：走纸带没有"总长"，只有此刻
  g.globalAlpha = alpha * 0.9;
  g.strokeStyle = C.brand;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(head, y - 12);
  g.lineTo(head, y + 12);
  g.stroke();
  g.fillStyle = C.brand;
  g.beginPath();
  g.moveTo(head - 2.6, y - 16.6);
  g.lineTo(head + 2.6, y - 16.6);
  g.lineTo(head, y - 11.8);
  g.closePath();
  g.fill();

  g.restore();
}
/** 一镜一枚读数：数字先落，单位后到 */
