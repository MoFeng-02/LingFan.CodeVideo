/**
 * 运行期 spawn 的异步 setup：帧内只登记链壳，帧边界物化。
 * 语义：链从「严格晚于 spawn 时刻的第一个采样点」整点开始（内容本地时间 0 对齐），
 * 等待发生在帧与帧之间，不依赖墙钟耗时 —— 同一剧本、同一份推演，结果与 I/O 快慢无关。
 */
import { describe, expect, it } from "vitest";
import type { SceneEnv, StepContext } from "@lingfan-video/contracts";
import { TimelineEngine, start } from "@lingfan-video/core";
import { MemoryFrameSink } from "@lingfan-video/infra";

const FPS = 10;
const W = 4;
const H = 4;

function makeEngine() {
  const engine = new TimelineEngine({
    fps: FPS,
    width: W,
    height: H,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
  });
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(W * H * 4),
    width: W,
    height: H,
  }));
  return engine;
}

/** 宿主：500ms 一段，t=100 时运行期 spawn 子场景 */
function program(child: unknown, options?: { at?: number; duration?: number }) {
  const at = options?.at ?? 100;
  const host = start({
    window: 500,
    run: (env: SceneEnv) => {
      env.step(500, (ctx: StepContext) => {
        if (Math.round(ctx.t) === at) {
          ctx.spawn(
            child as never,
            options?.duration === undefined
              ? { key: "late" }
              : { key: "late", duration: options.duration },
          );
        }
      });
    },
  });
  return { host };
}
async function run(head: Parameters<TimelineEngine["run"]>[0]) {
  const sink = new MemoryFrameSink();
  const summary = await makeEngine().run(head, sink);
  return summary;
}

describe("异步 setup 帧间物化", () => {
  it("链从 spawn 之后的第一个采样点整点开始，内容本地时间从 0 起算", async () => {
    const log: string[] = [];
    const late = start({
      window: 100,
      setup: async () => {},
      run: (env: SceneEnv) => {
        env.step(100, (ctx: StepContext) => {
          log.push(`child@${Math.round(ctx.t)}/${Math.round(ctx.localT)}`);
        });
      },
    });
    const { host } = program(late);
    const summary = await run(host);
    expect(summary.frames).toBeGreaterThan(0);
    expect(log).toContain("child@200/0");
  });

  it("两次推演的帧序与内容一致：I/O 快慢不影响结果", async () => {
    const runWithDelay = async (delayMs: number) => {
      const log: string[] = [];
      const late = start({
        window: 100,
        setup: async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        },
        run: (env: SceneEnv) => {
          env.step(100, (ctx: StepContext) => {
            log.push(`child@${Math.round(ctx.t)}/${Math.round(ctx.localT)}`);
          });
        },
      });
      const { host } = program(late);
      const summary = await run(host);
      return { frames: summary.frames, log };
    };
    const fast = await runWithDelay(0);
    const slow = await runWithDelay(5);
    expect(slow).toEqual(fast);
  });

  it("setup 失败：推演失败并指明运行期 spawn", async () => {
    const late = start({
      window: 100,
      setup: async () => {
        throw new Error("模型文件 404");
      },
      run: (env: SceneEnv) => {
        env.step(100, () => {});
      },
    });
    const { host } = program(late);
    await expect(run(host)).rejects.toThrow(/运行期 spawn 的 setup 失败/);
  });

  it("显式 duration 仍从 spawn 时刻起算：链尾不被物化边界推迟", async () => {
    const log: string[] = [];
    const late = start({
      window: 100,
      setup: async () => {},
      run: (env: SceneEnv) => {
        env.step(100, (ctx: StepContext) => {
          log.push(`child@${Math.round(ctx.t)}`);
        });
      },
    });
    const { host } = program(late, { duration: 150 });
    await run(host);
    expect(log).toContain("child@200");
    expect(log).not.toContain("child@400");
  });

  it("同步 setup 的运行期 spawn 行为不变：链起点就是 spawn 时刻（本地时间从 100 起算）", async () => {
    const log: string[] = [];
    const late = start({
      window: 300,
      setup: () => {},
      run: (env: SceneEnv) => {
        env.step(300, (ctx: StepContext) => {
          log.push(`child@${Math.round(ctx.t)}/${Math.round(ctx.localT)}`);
        });
      },
    });
    const { host } = program(late, { at: 100 });
    await run(host);
    // 下一帧 200ms 时链已活了 100ms（不是异步物化后的 0）
    expect(log).toContain("child@200/100");
  });
});
