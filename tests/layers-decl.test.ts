/**
 * 层声明：剧本说「有几层、叠在谁上面、什么时候在」，宿主按 id 配对渲染面。
 *
 * 四条断言：
 * ① 声明能穿过编译与引擎，按绝对故事时间出现在 `FrameHostInfo.layers` 里；
 * ② 声明是"声明"——不占帧窗池，有没有它帧数完全一样；
 * ③ 声明不合法立刻炸（空 id / 空区间），而不是画出一张错画面；
 * ④ 宿主按 id 配对：缺面直接报错，可见区间外不渲染，叠放次序由 z 决定。
 */
import { describe, expect, it } from "vitest";
import { render, start } from "@lingfan-video/core";
import type {
  ExportResult,
  Exporter,
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  LayerDeclaration,
  Ms,
} from "@lingfan-video/contracts";
import { createCompositeHost } from "@lingfan-video/infra";
import type { Compositor, LayerSurface } from "@lingfan-video/infra";
import { makeRecordingCanvas } from "./support/recording-canvas";

class DropExporter implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  count = 0;
  async writeFrame(_frame: FrameCarrier): Promise<void> {
    this.count += 1;
  }
  async finalize(): Promise<ExportResult> {
    return { output: "", frames: this.count, durationMs: 0, format: "frames" };
  }
}

/** 只记 begin 参数的宿主：本文件要验的就是"声明有没有传到位"。 */
class LayerSpyHost implements FrameHost {
  info: FrameHostInfo | null = null;
  begin(info: FrameHostInfo): void {
    this.info = info;
  }
  frame(): FrameCarrier {
    return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  }
}

type Renderable = Parameters<typeof render>[0];

const SCRIPT = (): Renderable =>
  start(900, (env) => {
    env.layer({ id: "a", z: 0, from: 100, to: 700 });
    env.step(300, () => undefined);
    env.layer({ id: "b", z: 10 });
    env.step(300, () => undefined);
    env.step(300, () => undefined);
  });

const runScript = async (
  scene: Renderable,
): Promise<{ exporter: DropExporter; host: LayerSpyHost }> => {
  const host = new LayerSpyHost();
  const exporter = new DropExporter();
  await render(scene, {
    fps: 30,
    width: 8,
    height: 8,
    canvas: makeRecordingCanvas(8, 8).canvas,
    exporter,
    painter: host,
    headless: true,
    frames: "allow-blank",
  });
  return { exporter, host };
};

describe("层声明", () => {
  it("穿过编译与引擎，按绝对故事时间交给宿主", async () => {
    const { host } = await runScript(SCRIPT());
    const layers = host.info?.layers ?? [];
    expect(layers.map((l) => l.id)).toEqual(["a", "b"]);
    // a 登记在第一帧（锚点 0）：区间 = 0+100 到 0+700
    expect(layers[0]).toMatchObject({ id: "a", z: 0, from: 100, to: 700 });
    // b 登记在 300ms 之后：缺省区间从登记处铺到本段收窗
    expect(layers[1]).toMatchObject({ id: "b", z: 10, from: 300, to: 900 });
  });

  it("是声明：占帧窗池的是 step，不是 layer", async () => {
    const withLayers = await runScript(SCRIPT());
    const withoutLayers = await runScript(
      start(900, (env) => {
        env.step(300, () => undefined);
        env.step(300, () => undefined);
        env.step(300, () => undefined);
      }),
    );
    expect(withLayers.exporter.count).toBe(withoutLayers.exporter.count);
    expect(withLayers.exporter.count).toBeGreaterThan(0);
  });

  it("非法声明在登记期就炸（空 id / 空区间）", async () => {
    await expect(
      runScript(start(300, (env) => env.layer({ id: " " }))),
    ).rejects.toThrow(/id 不能为空/);
    await expect(
      runScript(
        start(300, (env) => env.layer({ id: "x", from: 200, to: 100 })),
      ),
    ).rejects.toThrow(/可见区间为空/);
  });
});

const surfaceOf = (id: string): LayerSurface & { renders: Ms[] } => {
  const renders: Ms[] = [];
  return {
    id,
    width: 8,
    height: 8,
    canvas: makeRecordingCanvas(8, 8).canvas,
    render(frame: FrameIndex, timestampMs: Ms) {
      void frame;
      renders.push(timestampMs);
    },
    renders,
  };
};

/** 只记「这一帧叠了哪几层、什么次序」的合成器：Node 里没有 DOM，不建真画布。 */
const orderOf = (batches: string[][]): Compositor => ({
  id: "spy",
  begin() {},
  composite(input) {
    batches.push(input.layers.map((l) => l.spec.id));
    return Promise.resolve({
      kind: "handle",
      native: makeRecordingCanvas(8, 8).canvas,
      width: 8,
      height: 8,
      close() {},
    });
  },
  dispose() {},
});

const pairHost = (
  surfaces: Record<string, LayerSurface>,
  declared: readonly LayerDeclaration[],
  compositor: Compositor,
) =>
  createCompositeHost({
    base: makeRecordingCanvas(8, 8).canvas,
    width: 8,
    height: 8,
    surfaces,
    compositor,
  }).begin({
    fps: 30,
    width: 8,
    height: 8,
    durationMs: 1000,
    headless: true,
    layers: declared,
  });

describe("宿主按 id 配对渲染面", () => {
  it("只渲染本帧可见的层，按 z 从下往上", async () => {
    const x = surfaceOf("x");
    const y = surfaceOf("y");
    const batches: string[][] = [];
    const host = createCompositeHost({
      base: makeRecordingCanvas(8, 8).canvas,
      width: 8,
      height: 8,
      surfaces: { x, y },
      compositor: orderOf(batches),
    });
    await host.begin({
      fps: 30,
      width: 8,
      height: 8,
      durationMs: 1000,
      headless: true,
      layers: [
        { id: "y", z: 0, from: 200, to: 600 },
        { id: "x", z: 10 },
      ],
    });
    await host.frame(0, 100);
    await host.frame(1, 300);
    await host.frame(2, 700);
    expect(x.renders).toEqual([100, 300, 700]);
    expect(y.renders).toEqual([300]);
    // z 小的在下面：300ms 那一帧是 y 先、x 后
    expect(batches).toEqual([["x"], ["y", "x"], ["x"]]);
    await host.close();
  });

  it("剧本声明了层、宿主却没给面 → 明确报错（不静默少画一层）", async () => {
    await expect(
      pairHost({ x: surfaceOf("x") }, [{ id: "ghost" }], orderOf([])),
    ).rejects.toThrow(/剧本声明了层 "ghost".*surfaces/s);
  });

  it("剧本没声明层时走兼容路径（直接给成品层）", async () => {
    const x = surfaceOf("x");
    const batches: string[][] = [];
    const host = createCompositeHost({
      base: makeRecordingCanvas(8, 8).canvas,
      width: 8,
      height: 8,
      layers: [{ spec: { id: "x", z: 0 }, surface: x }],
      compositor: orderOf(batches),
    });
    await host.begin({
      fps: 30,
      width: 8,
      height: 8,
      durationMs: 500,
      headless: true,
    });
    await host.frame(0, 0);
    expect(x.renders).toEqual([0]);
    expect(batches).toEqual([["x"]]);
    await host.close();
  });
});
