/** 主读数块：代号、日期、能力词、读数、说明——一镜一枚刻度。 */
import { SHOTS, type Reading, type Shot } from "../script";
import { readingAt, type LedgerState } from "../program";
import { C, HERO_X, smooth, span, write } from "./style";
function paintReading(
  g: CanvasRenderingContext2D,
  state: LedgerState,
  reading: Reading,
  index: number,
  size: number,
  y: number,
): void {
  const at = readingAt(index);
  const appear = smooth(span(state.local, at, at + 320));
  const out = state.duration - 80;
  const alpha = appear * (1 - smooth(span(state.local, out - 160, out)));
  if (alpha <= 0) return;
  const lift = (1 - appear) * 5;
  const valueWidth = write(g, reading.value, HERO_X, y + lift, {
    size,
    mono: true,
    color: C.ink,
    alpha: alpha * 0.96,
    tracking: 0.5,
  });
  write(g, reading.unit, HERO_X + valueWidth + 7, y + lift, {
    size: 7,
    mono: true,
    color: C.dim,
    alpha: alpha * 0.8,
    tracking: 1.1,
  });
}

/** 主读数块：代号、日期、能力词、读数、一行说明 */
export function paintHero(
  g: CanvasRenderingContext2D,
  state: LedgerState,
): void {
  const shot: Shot = SHOTS[state.order]!;
  if (shot.mode === "boot" || shot.mode === "endcard") return;
  const local = state.local;
  const out =
    1 - smooth(span(local, state.duration - 200, state.duration - 40));

  // 左边一条细竖线：把"读数"框成一个仪表窗
  g.save();
  g.globalAlpha = out * 0.14;
  g.fillStyle = C.ice;
  g.fillRect(HERO_X - 9, 112, 0.6, 138);
  g.restore();

  if (state.code) {
    write(g, state.code, HERO_X, 122, {
      size: 10.5,
      mono: true,
      color: C.ice,
      alpha: smooth(span(local, 40, 400)) * 0.92 * out,
      tracking: 1.5,
    });
  }
  if (state.date) {
    write(g, state.date, HERO_X, 135, {
      size: 6.2,
      mono: true,
      color: C.dim,
      alpha: smooth(span(local, 160, 640)) * 0.7 * out,
      tracking: 1.2,
    });
  }

  if (state.verb) {
    const a = smooth(span(local, 120, 640)) * out;
    if (a > 0) {
      write(g, state.verb, HERO_X, 178 + (1 - a) * 7, {
        size: 31,
        weight: 600,
        color: C.ink,
        alpha: a,
        tracking: 0.8,
      });
    }
  }

  if (shot.readings?.length && state.revealed > 0) {
    const size = shot.mode === "event" ? 32 : 23;
    const y = shot.mode === "event" ? 212 : 210;
    // 只显示已经落下的最后一枚：三枚读数排队落地，不并排
    const shown = state.revealed - 1;
    paintReading(g, state, shot.readings[shown]!, shown, size, y);
  }

  if (state.caption) {
    const a = smooth(span(local, 420, 1_420)) * out;
    if (a > 0) {
      write(g, state.caption, HERO_X, 246 + (1 - a) * 5, {
        size: 12.5,
        color: C.ink,
        alpha: a * 0.88,
        tracking: 0.3,
      });
    }
  }
}

/** 遮罩：保住读数的对比度，同时不把三维场压死 */
