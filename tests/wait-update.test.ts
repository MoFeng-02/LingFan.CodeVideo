/**
 * B1：`wait(ms, onUpdate)` —— 自身不产帧，只在「同帧有其他活跃单元产帧」时逐帧回调。
 * 纯空窗（没有任何产帧单元）零回调是**已知边界**，不是缺陷。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, clip, start } from "@lingfan-video/core";
import type { Ms, Scene } from "@lingfan-video/contracts";

/** 裸引擎跑一遍：收集帧时间戳与运行摘要 */
async function runScene(
  scene: Scene<unknown>,
  fps = 20,
): Promise<{
  frames: Ms[];
  audioVoices: Awaited<ReturnType<TimelineEngine["run"]>>["audioVoices"];
}> {
  const engine = new TimelineEngine({
    fps,
    width: 1,
    height: 1,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
  });
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(4),
    width: 1,
    height: 1,
  }));
  const frames: Ms[] = [];
  const summary = await engine.run(scene, {
    writeFrame: (_f, _i, t) => {
      frames.push(t);
    },
    finalize: async () => {},
  });
  return { frames, audioVoices: summary.audioVoices };
}

interface WaitLog {
  t: Ms;
  localT: Ms;
  progress: number;
  frameIndex: number;
}

describe("wait(ms, onUpdate)：有帧的网格点上逐帧回调", () => {
  it("与并行 step 同窗：回调点 = 采样网格点，自身不额外产帧", async () => {
    const logs: WaitLog[] = [];
    const main = start(200, (env) => {
      env.par([
        (b) =>
          b.wait(200, (ctx) => {
            logs.push({
              t: ctx.t,
              localT: ctx.localT,
              progress: ctx.progress,
              frameIndex: ctx.frameIndex,
            });
          }),
        (b) => b.step(200, () => {}),
      ]);
    });

    const { frames } = await runScene(main);

    // 帧只由 step 贡献（wait 不额外加点）
    expect(frames).toEqual([0, 50, 100, 150]);
    expect(logs.map((l) => l.t)).toEqual([0, 50, 100, 150]);
    expect(logs.map((l) => l.localT)).toEqual([0, 50, 100, 150]);
    expect(logs.map((l) => l.progress)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(logs.map((l) => l.frameIndex)).toEqual([0, 1, 2, 3]);
  });

  it("wait 窗比产帧单元短：窗口外不回调", async () => {
    const times: Ms[] = [];
    const main = start(200, (env) => {
      env.par([
        (b) => b.wait(100, (ctx) => times.push(ctx.t)),
        (b) => b.step(200, () => {}),
      ]);
    });

    await runScene(main);
    expect(times).toEqual([0, 50]);
  });

  it("纯空窗：没有任何产帧单元 → 零帧零回调（已知边界）", async () => {
    let calls = 0;
    const main = start(200, (env) => {
      env.wait(200, () => {
        calls += 1;
      });
    });

    const { frames } = await runScene(main);
    expect(frames).toEqual([]);
    expect(calls).toBe(0);
  });

  it("回调里能发声、能消杀（能力集：audio + scheduler）", async () => {
    const childPaints: Ms[] = [];
    const child = start(200, (env) => {
      env.step(200, (ctx) => {
        childPaints.push(ctx.t);
      });
    });
    const main = start(200, (env) => {
      env.spawn(child, { key: "child", forever: true });
      env.par([
        (b) =>
          b.wait(200, (ctx) => {
            if (ctx.t !== 100) return;
            ctx.audio(clip("beep"));
            ctx.scheduler.kill("child");
          }),
        (b) => b.step(200, () => {}),
      ]);
    });

    const { audioVoices } = await runScene(main);

    expect(audioVoices).toHaveLength(1);
    expect(audioVoices[0]!.startMs).toBe(100);
    // t=100 那帧先画（spawn 链在前）再 kill；150 起不再求值
    expect(childPaints).toEqual([0, 50, 100]);
  });
});
