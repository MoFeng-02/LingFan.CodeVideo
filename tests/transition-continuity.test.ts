/**
 * 过场无缝的可测证据：同一段剧本，「硬切」会在切点留下一个像素尖峰，
 * 而「重叠窗 + 绝对时间遮盖」的帧序列是连续的。
 *
 * 判据用 frameDelta / continuityReport：不比较容器字节，只看逐帧像素差。
 * 画面由 painter 按 step 写下的取值产出，因此这里的连续性就是作者真正画出来的
 * 东西的连续性，而不是引擎内部计数的连续性。底部还叠了一条与剧本无关的慢扫灰阶，
 * 让「背景本身每帧都在小步变化」，尖峰判据才有参照物。
 */
import { describe, expect, it } from "vitest";
import type { Ms, StepContext } from "@lingfan-video/contracts";
import {
  TimelineEngine,
  coverProgress,
  createScene,
} from "@lingfan-video/core";
import {
  MemoryFrameSink,
  continuityReport,
  frameDelta,
} from "@lingfan-video/infra";

const FPS = 60;
const W = 4;
const H = 4;
/** 遮盖窗：从 300ms 开始、200ms 内遮满 */
const COVER_FROM = 300;
const COVER_MS = 200;
const A_VALUE = 60;
const B_VALUE = 200;
/** 硬切的时刻（= 重叠窗的终点，也是 B 段的独立起点） */
const CUT_AT = 500;

/** 与剧本无关的慢扫灰阶：三角波，周期 100ms、幅度 20 */
function sweep(atMs: Ms): number {
  const phase = (atMs % 100) / 100;
  return 30 + (phase < 0.5 ? phase * 40 : (1 - phase) * 40);
}

/** 逐帧累积器：同一帧内两段都写就相加（等价于黑底上的 alpha 叠化） */
interface PaintState {
  atMs: Ms;
  sum: number;
}

function emit(paint: PaintState, atMs: Ms, value: number): void {
  if (atMs !== paint.atMs) {
    paint.atMs = atMs;
    paint.sum = 0;
  }
  paint.sum += value;
}

function solid(value: number) {
  const data = new Uint8ClampedArray(W * H * 4);
  const v = Math.max(0, Math.min(255, Math.round(value)));
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}

/** A 500ms → B 400ms；给 overlapMs 走重叠窗，省略则是硬切 */
function program(overlapMs?: number) {
  const paint: PaintState = { atMs: -1, sum: 0 };
  const second = createScene(400, (_prev, env) => {
    env.step(400, (ctx: StepContext) => {
      emit(paint, ctx.t, B_VALUE * coverProgress(ctx.t, COVER_FROM, COVER_MS));
    });
  });
  const head = createScene(500, (_prev, env) => {
    env.step(500, (ctx: StepContext) => {
      emit(
        paint,
        ctx.t,
        A_VALUE * (1 - coverProgress(ctx.t, COVER_FROM, COVER_MS)),
      );
    });
    env.transitionTo(
      second,
      overlapMs === undefined ? undefined : { overlapMs },
    );
  });
  return { head, paint };
}

async function framesOf(overlapMs?: number) {
  const { head, paint } = program(overlapMs);
  const engine = new TimelineEngine({
    fps: FPS,
    width: W,
    height: H,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
  });
  engine.setPainter((_frame, t) => solid(paint.sum + sweep(t)));
  const sink = new MemoryFrameSink();
  await engine.run(head, sink);
  return sink.frames;
}

const seamFrame = Math.round(CUT_AT / (1000 / FPS));
/** deltas[i] 是第 i 帧与第 i+1 帧之差，所以切点落在 seamFrame - 1 */
const seamDelta = seamFrame - 1;

describe("过场切点的帧差", () => {
  it("硬切：切点出现一个明显尖峰", async () => {
    const frames = await framesOf();
    const report = continuityReport(frames);
    expect(report.spikeIndices).toContain(seamDelta);
    expect(report.maxDelta).toBeGreaterThan(100);
  });

  it("重叠窗 + 绝对时间遮盖：整段无尖峰，最大帧差只有叠化本身的斜率", async () => {
    const frames = await framesOf(200);
    const report = continuityReport(frames);
    expect(report.spikeIndices).toEqual([]);
    // 140 灰度差摊在 200ms 上（60fps → 每帧约 11.7），加底部慢扫约 6.7
    expect(report.maxDelta).toBeLessThan(25);
  });

  it("同一份像素脚本换成硬切才会跳：连续性来自写法，不是数据本身平滑", async () => {
    const overlap = await framesOf(200);
    const hard = await framesOf();
    const overlapDelta = frameDelta(
      overlap[seamDelta]!,
      overlap[seamDelta + 1]!,
    ).maxAbsDiff;
    const hardDelta = frameDelta(
      hard[seamDelta]!,
      hard[seamDelta + 1]!,
    ).maxAbsDiff;
    expect(overlapDelta).toBeLessThan(25);
    expect(hardDelta).toBeGreaterThan(100);
  });
});
