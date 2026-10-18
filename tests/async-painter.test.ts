/**
 * 可等待的帧来源：宿主没有同步抓帧能力时（DOM/HTML/React/Vue 栅格化、GPU 读回），
 * 引擎在帧边界等它完成再交帧。覆盖四件事：
 * 1. 异步来源可用：帧序号、时间戳、像素都正确；
 * 2. 取帧慢也不丢帧，且严格串行（不重叠取帧）；
 * 3. 取帧失败会让本次渲染失败，且带得出原因；
 * 4. 同步来源照旧可用，两条路径像素一致。
 */
import { describe, expect, it } from "vitest";
import { render, start } from "@lingfan-video/core";
import type { FrameBitmap } from "@lingfan-video/contracts";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const W = 8;
const H = 4;
const FPS = 10;
const DURATION_MS = 300;
const FRAMES = (DURATION_MS / 1000) * FPS;

function paintScene() {
  return start(DURATION_MS, (env) => {
    env.step(DURATION_MS, () => {});
  });
}

function bitmapWith(red: number): FrameBitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = red;
    data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}

describe("可等待的帧来源", () => {
  it("异步来源：帧序号与时间戳按网格顺序交出", async () => {
    const exporter = new FrameSequenceExporter();
    const calls: Array<{ frame: number; t: number }> = [];
    const result = await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter,
      painter: async (frame, t) => {
        calls.push({ frame, t });
        await Promise.resolve();
        return bitmapWith(frame);
      },
    });
    expect(result.frames).toBe(FRAMES);
    expect(exporter.frames).toHaveLength(FRAMES);
    expect(calls).toEqual(
      Array.from({ length: FRAMES }, (_, i) => ({ frame: i, t: i * 100 })),
    );
    exporter.frames.forEach((frame, index) =>
      expect(frame.data[0]).toBe(index),
    );
  });

  it("取帧慢也不丢帧，且严格串行（不重叠取帧）", async () => {
    const exporter = new FrameSequenceExporter();
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter,
      painter: async (frame) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return bitmapWith(frame);
      },
    });
    expect(result.frames).toBe(FRAMES);
    expect(exporter.frames).toHaveLength(FRAMES);
    expect(maxInFlight).toBe(1);
  });

  it("取帧失败：本次渲染失败，原因可见", async () => {
    const exporter = new FrameSequenceExporter();
    await expect(
      render(paintScene(), {
        fps: FPS,
        width: W,
        height: H,
        exporter,
        painter: async () => {
          throw new Error("宿主栅格化失败：DOM 尚未提交");
        },
      }),
    ).rejects.toThrow(/宿主栅格化失败/);
  });

  it("同步来源照旧可用：与异步路径得到相同像素", async () => {
    const sync = new FrameSequenceExporter();
    const async = new FrameSequenceExporter();
    await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter: sync,
      painter: (frame) => bitmapWith(frame),
    });
    await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter: async,
      painter: async (frame) => bitmapWith(frame),
    });
    expect(sync.frames.map((f) => f.data[0])).toEqual(
      async.frames.map((f) => f.data[0]),
    );
  });
});
