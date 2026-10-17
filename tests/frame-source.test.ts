/**
 * 帧像素来源：单一事实来源是绘制目标 canvas。
 * 钉三件事：①缺省从画布 2D 回读（导出帧不是空白）②注入 painter 时以注入为准
 * ③无 2D 上下文时退回零位图（模拟仍可跑，属配置缺失）。
 */
import { describe, expect, it } from "vitest";
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const W = 4;
const H = 4;

/** 假画布：可注入像素，并统计回读次数 */
function makeCanvas(fill: number) {
  const state = { reads: 0 };
  const ctx = {
    fillRect: () => {},
    getImageData: (x: number, y: number, w: number, h: number) => {
      state.reads += 1;
      void x;
      void y;
      return {
        data: new Uint8ClampedArray(w * h * 4).fill(fill),
        width: w,
        height: h,
      };
    },
  };
  const canvas = {
    width: W,
    height: H,
    getContext: (kind: string) => (kind === "2d" ? ctx : null),
  } as unknown as HTMLCanvasElement;
  return { canvas, state, ctx };
}

function drawScene() {
  return start(100, (env) => {
    env.step(100, (ctx) => {
      const c = ctx.canvas as HTMLCanvasElement;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.fillRect(0, 0, W, H);
    });
  });
}

describe("帧像素来源", () => {
  it("缺省从绘制目标画布回读：导出帧即画布上画的内容", async () => {
    const { canvas, state } = makeCanvas(200);
    const exporter = new FrameSequenceExporter();
    await render(drawScene(), {
      fps: 10,
      width: W,
      height: H,
      headless: true,
      canvas,
      exporter,
    });
    expect(exporter.frames.length).toBeGreaterThan(0);
    expect(state.reads).toBe(exporter.frames.length);
    for (const frame of exporter.frames) {
      expect(frame.width).toBe(W);
      expect(frame.data[0]).toBe(200);
    }
  });

  it("注入 painter 时以注入为准（GPU/离屏路径自绘）", async () => {
    const { canvas, state } = makeCanvas(200);
    const exporter = new FrameSequenceExporter();
    await render(drawScene(), {
      fps: 10,
      width: W,
      height: H,
      headless: true,
      canvas,
      exporter,
      painter: () => ({
        data: new Uint8ClampedArray(W * H * 4).fill(7),
        width: W,
        height: H,
      }),
    });
    expect(state.reads).toBe(0);
    expect(exporter.frames[0]?.data[0]).toBe(7);
  });

  it("无 2D 上下文时退回零位图，模拟与计时照常", async () => {
    const canvas = {
      width: W,
      height: H,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const exporter = new FrameSequenceExporter();
    const scene = start(100, (env) => {
      env.step(100, () => {});
    });
    const result = await render(scene, {
      fps: 10,
      width: W,
      height: H,
      headless: true,
      canvas,
      exporter,
    });
    expect(result.frames).toBeGreaterThan(0);
    expect(exporter.frames[0]?.data.every((v) => v === 0)).toBe(true);
  });
});
