import type { InputEvent, StepContext } from "@lingfan-video/contracts";

/**
 * 演示输入脚本：指针划入 → 按下拖动 → 抬起，再敲一次空格。
 * 时刻是全局时间线毫秒，坐标归一化到单位方格——预览与导出注入同一份，画面因此一致。
 */
export const INPUT_EVENTS: readonly InputEvent[] = [
  { atMs: 1200, kind: "pointer", type: "move", x: 0.2, y: 0.55 },
  { atMs: 1400, kind: "pointer", type: "down", x: 0.2, y: 0.55 },
  { atMs: 1650, kind: "pointer", type: "move", x: 0.35, y: 0.4 },
  { atMs: 1950, kind: "pointer", type: "move", x: 0.7, y: 0.5 },
  { atMs: 2150, kind: "pointer", type: "up", x: 0.7, y: 0.5 },
  { atMs: 2500, kind: "key", type: "down", key: " " },
  { atMs: 2750, kind: "key", type: "up", key: " " },
];

/** 把本帧输入快照画成指示器：指针圆环（按下时实心）+ 文本读数 */
export function drawInputOverlay(ctx: StepContext): void {
  const c = ctx.canvas as HTMLCanvasElement;
  const g = c.getContext("2d");
  if (!g) return;
  const { pointer, keys } = ctx.input;
  const x = pointer.x * ctx.width;
  const y = pointer.y * ctx.height;
  g.save();
  g.strokeStyle = pointer.down ? "#7cf7a8" : "rgba(200,210,255,0.7)";
  g.lineWidth = pointer.down ? 3 : 2;
  g.beginPath();
  g.arc(x, y, pointer.down ? 16 : 12, 0, Math.PI * 2);
  g.stroke();
  if (pointer.down) {
    g.fillStyle = "rgba(124,247,168,0.25)";
    g.fill();
  }
  g.fillStyle = "rgba(232,232,255,0.75)";
  g.font = "300 13px 'Segoe UI', sans-serif";
  g.textAlign = "left";
  g.fillText(
    `pointer (${pointer.x.toFixed(2)}, ${pointer.y.toFixed(2)})`,
    16,
    ctx.height - 34,
  );
  g.fillText(keys.has(" ") ? "Space 按下" : "Space 未按", 16, ctx.height - 16);
  g.restore();
}
