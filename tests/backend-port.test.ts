/**
 * 渲染后端是端口，不是 canvas。
 * 覆盖三件事：
 * 1. 框架自绘（只注入 painter）：不给 canvas、不开 headless，Node 下也照常出帧；
 * 2. 像素只由 painter 决定，引擎不碰绘制目标（碰了就会炸）；
 * 3. backend 是开放适配器标识：任意名字都接受，且不改变任何行为。
 */
import { describe, expect, it } from "vitest";
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const W = 8;
const H = 4;
const FPS = 10;
const DURATION_MS = 300;
const FRAMES = (DURATION_MS / 1000) * FPS;

/** 剧本只推进时间，画面全部由外部框架自绘（不碰 canvas） */
function paintScene() {
  return start(DURATION_MS, (env) => {
    env.step(DURATION_MS, () => {});
  });
}

/** 框架自绘的帧来源：红通道 = 帧序号，用来证明像素来自 painter 而不是绘制目标 */
function frameIndexPainter() {
  return (frame: number) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = frame;
      data[i + 3] = 255;
    }
    return { data, width: W, height: H };
  };
}

function redOf(frame: { data: Uint8ClampedArray } | undefined): number {
  return frame?.data[0] ?? -1;
}

describe("渲染后端是端口", () => {
  it("只注入 painter、不给 canvas、不开 headless：Node 下照常出帧", async () => {
    const exporter = new FrameSequenceExporter();
    const result = await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter,
      painter: frameIndexPainter(),
    });
    expect(result.frames).toBe(FRAMES);
    expect(exporter.frames).toHaveLength(FRAMES);
    exporter.frames.forEach((frame, index) => {
      expect(redOf(frame)).toBe(index);
    });
  });

  it("像素只由 painter 决定：引擎不读绘制目标", async () => {
    const exporter = new FrameSequenceExporter();
    const untouched = {
      width: W,
      height: H,
      getContext: () => {
        throw new Error("引擎不该碰绘制目标：像素应由 painter 交出");
      },
    } as unknown as HTMLCanvasElement;
    const result = await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter,
      canvas: untouched,
      painter: frameIndexPainter(),
    });
    expect(result.frames).toBe(FRAMES);
    expect(redOf(exporter.frames[0])).toBe(0);
  });

  it("backend 是开放标识：任意适配器名都接受且不影响帧", async () => {
    const asFramework = new FrameSequenceExporter();
    const asCanvas = new FrameSequenceExporter();
    const scene = paintScene();
    await render(scene, {
      fps: FPS,
      width: W,
      height: H,
      exporter: asFramework,
      painter: frameIndexPainter(),
      backend: "framework:three",
    });
    await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter: asCanvas,
      painter: frameIndexPainter(),
      backend: "2d",
    });
    expect(asFramework.frames).toHaveLength(FRAMES);
    expect(asCanvas.frames).toHaveLength(FRAMES);
    asFramework.frames.forEach((frame, index) => {
      expect(redOf(frame)).toBe(redOf(asCanvas.frames[index]));
    });
  });
});
