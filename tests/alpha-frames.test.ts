/**
 * 透明帧：一次声明如何贯穿到画布与封装。
 * 覆盖：
 * 1. `RenderOptions.alpha` 经 `FrameHostInfo.alpha` 交到宿主（不声明则不带该键）；
 * 2. 合成宿主把 alpha 交给合成器的 `begin`，显式 options.alpha 优先；
 * 3. Canvas2D 合成器按 alpha 创建上下文——不透明档关掉 alpha，透明档打开；
 * 4. 声明了透明却选了装不下 alpha 的封装，在首帧前报错。
 */
import { describe, expect, it, vi } from "vitest";
import { render, start } from "@lingfan-video/core";
import type {
  ExportFormat,
  ExportResult,
  Exporter,
  ExporterImpl,
  FrameBitmap,
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  Ms,
} from "@lingfan-video/contracts";
import {
  FrameSequenceExporter,
  createCanvas2dCompositor,
  createCompositeHost,
} from "@lingfan-video/infra";
import type { Compositor } from "@lingfan-video/infra";

const W = 8;
const H = 4;
const FPS = 10;
const DURATION_MS = 200;

function paintScene() {
  return start(DURATION_MS, (env) => {
    env.step(DURATION_MS, () => {});
  });
}

function bitmap(): FrameBitmap {
  return { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
}

/** 只记录 begin 参数与合成次数的合成器替身 */
function spyCompositor(
  begins: { alpha?: string; width: number }[],
): Compositor {
  return {
    id: "spy",
    begin(size) {
      begins.push({
        ...(size.alpha === undefined ? {} : { alpha: size.alpha }),
        width: size.width,
      });
    },
    composite() {
      return Promise.resolve({
        kind: "handle",
        native: { width: W, height: H },
        width: W,
        height: H,
        close() {},
      });
    },
    dispose() {},
  };
}

/** 记录每次取上下文时的选项，供断言 alpha 开关 */
function stubOffscreenCanvas(): { options: unknown[] } {
  const options: unknown[] = [];
  const context = {
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    clearRect() {},
    drawImage() {},
  };
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext(_kind: string, opts?: unknown) {
      options.push(opts);
      return context;
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  return { options };
}

/** 固定格式的导出器替身：只为触发「声明与产物对不上」的守卫 */
class FormatOnlyExporter implements Exporter {
  readonly impl: ExporterImpl;
  readonly format: ExportFormat;
  writes = 0;
  constructor(format: ExportFormat, impl: ExporterImpl) {
    this.format = format;
    this.impl = impl;
  }
  writeFrame(_frame: FrameCarrier, _timestampMs: Ms): Promise<void> {
    this.writes += 1;
    return Promise.resolve();
  }
  finalize(): Promise<ExportResult> {
    return Promise.resolve({
      output: "",
      frames: this.writes,
      durationMs: 0,
      format: this.format,
    });
  }
}

describe("透明帧：声明从入口走到画布", () => {
  it("声明 alpha 时随 FrameHostInfo 交给宿主；不声明则不带这个键", async () => {
    const infos: FrameHostInfo[] = [];
    const host: FrameHost = {
      begin(info) {
        infos.push(info);
      },
      frame() {
        return bitmap();
      },
    };
    await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter: new FrameSequenceExporter(),
      painter: host,
      alpha: "alpha",
    });
    await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter: new FrameSequenceExporter(),
      painter: host,
    });
    expect(infos[0]!.alpha).toBe("alpha");
    expect("alpha" in (infos[1] as FrameHostInfo)).toBe(false);
  });

  it("合成宿主把 alpha 交给合成器的 begin，显式 options.alpha 优先", async () => {
    const declared: { alpha?: string; width: number }[] = [];
    const base = { width: W, height: H } as unknown as HTMLCanvasElement;

    const fromInfo = createCompositeHost({
      base,
      width: W,
      height: H,
      compositor: spyCompositor(declared),
    });
    await fromInfo.begin({
      fps: FPS,
      width: W,
      height: H,
      durationMs: DURATION_MS,
      headless: true,
      alpha: "alpha",
    });
    await fromInfo.close();

    const explicit: { alpha?: string; width: number }[] = [];
    const fromOption = createCompositeHost({
      base,
      width: W,
      height: H,
      alpha: "alpha",
      compositor: spyCompositor(explicit),
    });
    await fromOption.begin({
      fps: FPS,
      width: W,
      height: H,
      durationMs: DURATION_MS,
      headless: true,
      alpha: "opaque",
    });
    await fromOption.close();

    expect(declared[0]!.alpha).toBe("alpha");
    expect(explicit[0]!.alpha).toBe("alpha");
  });

  it("Canvas2D 合成器按 alpha 档创建上下文", async () => {
    const { options } = stubOffscreenCanvas();
    const opaque = createCanvas2dCompositor();
    await opaque.begin({ width: W, height: H });
    opaque.dispose();

    const transparent = createCanvas2dCompositor();
    await transparent.begin({ width: W, height: H, alpha: "alpha" });
    transparent.dispose();

    expect(options[0]).toEqual({ alpha: false });
    expect(options[1]).toEqual({ alpha: true });
    vi.unstubAllGlobals();
  });

  it('声明 "alpha" 却用 mp4 封装：首帧前报错，且不写任何帧', async () => {
    const exporter = new FormatOnlyExporter("mp4", "webcodecs");
    await expect(
      render(paintScene(), {
        fps: FPS,
        width: W,
        height: H,
        exporter,
        painter: () => bitmap(),
        alpha: "alpha",
        frames: "allow-blank",
      }),
    ).rejects.toThrow(/装不下 alpha（format 是 "mp4"）/);
    expect(exporter.writes).toBe(0);
  });

  it("不声明透明时 mp4 照常放行（守卫只管对不上的那一侧）", async () => {
    const exporter = new FormatOnlyExporter("mp4", "webcodecs");
    const result = await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter,
      painter: () => bitmap(),
      frames: "allow-blank",
    });
    expect(result.frames).toBe((DURATION_MS / 1000) * FPS);
  });
});
