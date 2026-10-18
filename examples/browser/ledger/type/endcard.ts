/** 落版：标准字标、代号、日期、一句话、联动署名；以及压在画面上的遮罩。 */
import { DESIGN, END_CARD } from "../script";
import type { LedgerState } from "../program";
import { drawMark } from "../brand";
import { C, smooth, span, write } from "./style";
export function endCardFade(state: LedgerState): number {
  if (state.mode !== "endcard") return 1;
  return 1 - smooth(span(state.local, END_CARD.out, END_CARD.window));
}

/** 顶栏：字标、这是谁的记录、现在到哪 */
export function paintScrims(g: CanvasRenderingContext2D): void {
  // 左侧
  const left = g.createLinearGradient(0, 0, 330, 0);
  left.addColorStop(0, "rgba(5,7,12,0.88)");
  left.addColorStop(1, "rgba(5,7,12,0)");
  g.fillStyle = left;
  g.fillRect(0, 0, 330, DESIGN.height);

  // 底部
  const bottom = g.createLinearGradient(0, 236, 0, DESIGN.height);
  bottom.addColorStop(0, "rgba(5,7,12,0)");
  bottom.addColorStop(1, "rgba(5,7,12,0.94)");
  g.fillStyle = bottom;
  g.fillRect(0, 236, DESIGN.width, DESIGN.height - 236);

  // 顶部（压住三维场的高光）
  const top = g.createLinearGradient(0, 0, 0, 46);
  top.addColorStop(0, "rgba(5,7,12,0.8)");
  top.addColorStop(1, "rgba(5,7,12,0)");
  g.fillStyle = top;
  g.fillRect(0, 0, DESIGN.width, 46);
}

/** 落版：仪表关机，只剩字标与一句话（时刻全是段内偏移） */
export function paintEndCard(
  g: CanvasRenderingContext2D,
  state: LedgerState,
): void {
  const local = state.local;
  // 遮到全黑再写字：底下的刻度尺、顶栏不该和落版文字叠在一起
  const veil = smooth(span(local, 0, 2_000));
  if (veil > 0) {
    g.save();
    g.globalAlpha = veil;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, DESIGN.width, DESIGN.height);
    g.restore();
  }
  const out = endCardFade(state);
  if (out <= 0) return;

  const height = 24;
  const width = (512 / 109) * height;
  const markAlpha =
    smooth(span(local, END_CARD.at.mark, END_CARD.at.mark + 620)) * out;
  if (markAlpha > 0) {
    drawMark(g, DESIGN.width / 2 - width / 2, 128, {
      height,
      color: C.ink,
      alpha: markAlpha,
    });
  }

  const codeAlpha =
    smooth(span(local, END_CARD.at.code, END_CARD.at.code + 500)) * out;
  if (codeAlpha > 0) {
    write(g, END_CARD.code, DESIGN.width / 2, 198, {
      size: 9,
      mono: true,
      color: C.ice,
      alpha: codeAlpha * 0.95,
      tracking: 2,
      align: "center",
    });
  }
  const dateAlpha =
    smooth(span(local, END_CARD.at.date, END_CARD.at.date + 460)) * out;
  if (dateAlpha > 0) {
    write(g, END_CARD.date, DESIGN.width / 2, 212, {
      size: 6.4,
      mono: true,
      color: C.dim,
      alpha: dateAlpha * 0.75,
      tracking: 1.4,
      align: "center",
    });
  }
  const lineAlpha =
    smooth(span(local, END_CARD.at.line, END_CARD.at.line + 620)) * out;
  if (lineAlpha > 0) {
    write(g, END_CARD.line, DESIGN.width / 2, 240, {
      size: 12.5,
      color: C.ink,
      alpha: lineAlpha * 0.92,
      tracking: 0.6,
      align: "center",
    });
  }

  // 联动署名：一行写完，不再两行挤在一起
  const firstCredit = END_CARD.at.credits[0]!;
  const ruleAlpha =
    smooth(span(local, firstCredit - 400, firstCredit - 20)) * out;
  if (ruleAlpha > 0) {
    g.save();
    g.globalAlpha = ruleAlpha * 0.18;
    g.fillStyle = C.ice;
    g.fillRect(DESIGN.width / 2 - 22, 256, 44, 0.5);
    g.restore();
  }
  const creditAlpha = smooth(span(local, firstCredit, firstCredit + 520)) * out;
  if (creditAlpha > 0) {
    write(g, END_CARD.credits.join(" · "), DESIGN.width / 2, 274, {
      size: 6.6,
      mono: true,
      color: C.dim,
      alpha: creditAlpha * 0.72,
      tracking: 1.5,
      align: "center",
    });
  }
}
