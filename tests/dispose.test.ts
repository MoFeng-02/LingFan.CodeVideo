/**
 * 消杀与消亡过程（id 覆盖 / fadeOut 消亡窗口 / 内部自消杀）。
 * 语义：`kill`/`dispose` 带 fadeOut → 窗口内继续逐帧求值、回调拿
 * `disposing=true` + `disposeProgress` 0→1；窗口结束才真正出池。
 */
import { describe, expect, it } from "vitest";
import { start, TimelineEngine } from "@lingfan-video/core";
import type { Handle, Ms, Scene } from "@lingfan-video/contracts";

/** 裸引擎跑一遍：收集帧时间戳 + 绘制回调按场景记日志 */
async function runScene(scene: Scene<unknown>, fps = 20): Promise<Ms[]> {
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
  const times: Ms[] = [];
  await engine.run(scene, {
    writeFrame: (_f, t) => {
      times.push(t);
    },
    finalize: async () => {},
  });
  return times;
}

interface PaintLog {
  t: Ms;
  disposing: boolean;
  progress: number;
}

describe("kill(key, { fadeOut })：整条 spawn 链的消亡窗口", () => {
  it("窗口内继续求值并暴露 disposing/disposeProgress，窗口结束出池", async () => {
    const childPaints: PaintLog[] = [];
    const child = start(200, (env) => {
      env.step(200, (ctx) => {
        childPaints.push({
          t: ctx.t,
          disposing: ctx.disposing,
          progress: ctx.disposeProgress,
        });
      });
    });
    let handle: Handle | undefined;
    let killed = false;
    const main = start(400, (env) => {
      env.step(400, (ctx) => {
        if (!handle) handle = ctx.spawn(child, { key: "child", forever: true });
        if (!killed && ctx.t >= 100) {
          killed = true;
          handle.kill({ fadeOut: 100 });
        }
      });
    });

    await runScene(main);

    // 子链在 t=0 由主链 spawn（当帧尚未入列）→ 首次绘制在 50
    expect(childPaints.map((p) => p.t)).toEqual([50, 100, 150]);
    expect(childPaints[0]!.disposing).toBe(false);
    expect(childPaints[1]!.disposing).toBe(false);
    // 窗口 [100,200)：t=150 → progress 0.5
    expect(childPaints[2]!.disposing).toBe(true);
    expect(childPaints[2]!.progress).toBeCloseTo(0.5, 5);
  });

  it("不带 fadeOut = 立即死（之后不再绘制）", async () => {
    const childPaints: Ms[] = [];
    const child = start(200, (env) => {
      env.step(200, (ctx) => {
        childPaints.push(ctx.t);
      });
    });
    let handle: Handle | undefined;
    let killed = false;
    const main = start(400, (env) => {
      env.step(400, (ctx) => {
        if (!handle) handle = ctx.spawn(child, { key: "child", forever: true });
        if (!killed && ctx.t >= 100) {
          killed = true;
          handle.kill();
        }
      });
    });

    await runScene(main);
    expect(childPaints).toEqual([50, 100]);
  });
});

describe("ctx.dispose()：函数内部触发自己的消亡过程", () => {
  it("主链单元自消杀 + fadeOut：窗口内继续画，窗口结束停", async () => {
    const paints: PaintLog[] = [];
    let fired = false;
    const scene = start(500, (env) => {
      env.step(500, (ctx) => {
        paints.push({
          t: ctx.localT,
          disposing: ctx.disposing,
          progress: ctx.disposeProgress,
        });
        if (!fired && ctx.localT >= 100) {
          fired = true;
          ctx.dispose({ fadeOut: 100 });
        }
      });
    });

    await runScene(scene, 40);

    expect(paints.map((p) => p.t)).toEqual([0, 25, 50, 75, 100, 125, 150, 175]);
    const dying = paints.filter((p) => p.disposing);
    expect(dying.map((p) => p.t)).toEqual([125, 150, 175]);
    expect(dying[0]!.progress).toBeCloseTo(0.25, 5);
    expect(dying[2]!.progress).toBeCloseTo(0.75, 5);
    // 2026-10-17 新增：窗口结束后不再有回调（帧仍按采样网格产出）
    expect(paints.every((p) => p.t < 200)).toBe(true);
  });
});

describe("scheduler.kill(id)：按名字消杀 step/loop 单元", () => {
  it("par 分支里按 id 杀另一个分支的单元，带消亡窗口", async () => {
    const aPaints: PaintLog[] = [];
    let killed = false;
    const scene = start(400, (env) => {
      env.par([
        (branch) => {
          branch.step(
            400,
            (ctx) => {
              aPaints.push({
                t: ctx.t,
                disposing: ctx.disposing,
                progress: ctx.disposeProgress,
              });
            },
            { id: "title" },
          );
        },
        (branch) => {
          branch.step(400, (ctx) => {
            if (!killed && ctx.t >= 100) {
              killed = true;
              ctx.scheduler.kill("title", { fadeOut: 100 });
            }
          });
        },
      ]);
    });

    await runScene(scene);

    expect(aPaints.map((p) => p.t)).toEqual([0, 50, 100, 150]);
    expect(aPaints[2]!.disposing).toBe(false);
    expect(aPaints[3]!.disposing).toBe(true);
    expect(aPaints[3]!.progress).toBeCloseTo(0.5, 5);
  });
});
