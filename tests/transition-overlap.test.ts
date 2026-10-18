/**
 * 过场重叠窗：transitionTo(next, { overlapMs }) 让两段在窗口内同时求值。
 * 缺省仍是硬切（任何时刻只有一段活跃）；重叠是显式代价——总长共用一段，
 * 换来两段同时在场的叠化/擦除，不要求作者写遮盖、也不需要绝对时间对齐。
 */
import { describe, expect, it } from "vitest";
import type { SceneEnv, StepContext } from "@lingfan-video/contracts";
import { TimelineEngine, createScene } from "@lingfan-video/core";
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

/** step 回调按全局时刻登记一行 `A@300`，用来断言两段是否同帧在场 */
function mark(log: string[], name: string) {
  return (ctx: StepContext): void => {
    log.push(`${name}@${Math.round(ctx.t)}`);
  };
}

/** A 500ms → transitionTo(B 400ms)，可给重叠窗 */
function twoActProgram(overlapMs?: number) {
  const log: string[] = [];
  const second = createScene(400, (_prev, env: SceneEnv) => {
    env.step(400, mark(log, "B"));
  });
  const head = createScene(500, (_prev, env: SceneEnv) => {
    env.step(500, mark(log, "A"));
    env.transitionTo(
      second,
      overlapMs === undefined ? undefined : { overlapMs },
    );
  });
  return { head, log };
}

async function run(head: Parameters<TimelineEngine["run"]>[0]) {
  const sink = new MemoryFrameSink();
  const summary = await makeEngine().run(head, sink);
  return { summary, sink };
}

describe("硬切（缺省）", () => {
  it("两段串行：帧不丢不重，任何时刻只有一段 step 被调用", async () => {
    const { head, log } = twoActProgram();
    const { summary } = await run(head);
    // A 的 5 个采样点 + B 的 4 个采样点
    expect(summary.frames).toBe(9);
    expect(summary.durationMs).toBe(900);
    expect(log).toEqual([
      "A@0",
      "A@100",
      "A@200",
      "A@300",
      "A@400",
      "B@500",
      "B@600",
      "B@700",
      "B@800",
    ]);
  });
});

describe("重叠窗", () => {
  it("两段在窗口内同帧求值，总长按共享段扣减", async () => {
    const { head, log } = twoActProgram(200);
    const { summary } = await run(head);
    // 并集网格：A 的 0..400 与 B 的 300..600
    expect(summary.frames).toBe(7);
    expect(summary.durationMs).toBe(700);
    // 300/400 两帧两段都在；500 起只剩 B
    expect(log.filter((line) => line.endsWith("@300"))).toEqual([
      "A@300",
      "B@300",
    ]);
    expect(log.filter((line) => line.endsWith("@400"))).toEqual([
      "A@400",
      "B@400",
    ]);
    expect(log.filter((line) => line.endsWith("@500"))).toEqual(["B@500"]);
  });

  it("采样网格在重叠窗内无空洞：时间戳即为并集", async () => {
    const { head } = twoActProgram(250);
    const { sink } = await run(head);
    // A 0/100/200/300/400，B 从 250 起：250/350/450/550（650 是 B 的结束边界，不含）
    expect(sink.timestamps).toEqual([
      0, 100, 200, 250, 300, 350, 400, 450, 550,
    ]);
    for (let i = 1; i < sink.timestamps.length; i++)
      expect(sink.timestamps[i]!).toBeGreaterThan(sink.timestamps[i - 1]!);
  });

  it("非法重叠窗：0 / 负数 / NaN 在登记期即报 spec_violation", async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const { head } = twoActProgram(bad);
      await expect(run(head)).rejects.toThrow(/overlapMs/);
    }
  });

  it("重叠窗吃满本段：报错并指出收窗长度", async () => {
    const { head } = twoActProgram(500);
    await expect(run(head)).rejects.toThrow(/不能吃满整段/);
  });

  it("重叠窗不小于下一段长度：报错（下一段会没有独立窗口）", async () => {
    const { head } = twoActProgram(400);
    await expect(run(head)).rejects.toThrow(/不小于本段长度/);
  });

  it("spawn 链内部同样支持重叠窗", async () => {
    const log: string[] = [];
    const tail = createScene(300, (_prev, env: SceneEnv) => {
      env.step(300, mark(log, "S2"));
    });
    const spawned = createScene(200, (_prev, env: SceneEnv) => {
      env.step(200, mark(log, "S1"));
      env.transitionTo(tail, { overlapMs: 100 });
    });
    const head = createScene(500, (_prev, env: SceneEnv) => {
      env.spawn(spawned, { key: "chain", duration: 600 });
    });
    const { summary } = await run(head);
    // 链网格：S1 的 0/100 与 S2 的 100/200/300 → 0,100,200,300；链内容止于 400，
    // 主链无单元，故总长取主链 500
    expect(summary.frames).toBe(4);
    expect(summary.durationMs).toBe(500);
    expect(log.filter((line) => line.endsWith("@100"))).toEqual([
      "S1@100",
      "S2@100",
    ]);
  });
});
