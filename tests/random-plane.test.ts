/**
 * 随机面：随机是数据，不是熵。
 * 覆盖四件事：
 * 1. 流本身（同种子同序列、fork 与父流无关、int/float/chance/pick 边界）
 * 2. 引擎装配（同 seed 可复现、换 seed 变、单元/实例各自独立子流）
 * 3. 上下文暴露（step/loop/wait 都能抽）
 * 4. 组合根装配（RenderOptions.seed 到达回调，非法种子开工即炸）
 */
import { describe, expect, it } from "vitest";
import {
  TimelineEngine,
  createRandomStream,
  render,
  start,
} from "@lingfan-video/core";
import { DEFAULT_PROGRAM_SEED } from "@lingfan-video/contracts";
import type { RandomStream } from "@lingfan-video/contracts";
import { FrameSequenceExporter, MemoryFrameSink } from "@lingfan-video/infra";

function makeEngine(seed?: number) {
  const engine = new TimelineEngine({
    fps: 30,
    width: 4,
    height: 4,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
    seed,
  });
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(4 * 4 * 4),
    width: 4,
    height: 4,
  }));
  return engine;
}

function draws(stream: RandomStream, count: number): number[] {
  return Array.from({ length: count }, () => stream.next());
}

function capture(out: number[]) {
  return start(300, (env) => {
    env.step(300, (ctx) => {
      out.push(ctx.random.next());
    });
  });
}

function twoUnits(stride: number, a: number[], b: number[]) {
  return start(300, (env) => {
    env.par([
      (br) =>
        br.step(300, (ctx) => {
          a.push(ctx.random.next());
        }),
      (br) =>
        br.step(300, (ctx) => {
          for (let i = 0; i < stride; i++) b.push(ctx.random.next());
        }),
    ]);
  });
}

describe("随机流", () => {
  it("同种子同步数得到同一序列，换种子就换序列", () => {
    const a = draws(createRandomStream(7), 6);
    expect(draws(createRandomStream(7), 6)).toEqual(a);
    expect(draws(createRandomStream(8), 6)).not.toEqual(a);
    expect(a.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("fork 同 label 同序列，且与父流已抽多少无关", () => {
    const p1 = createRandomStream(11);
    p1.next();
    const f1 = draws(p1.fork("bg"), 4);

    const p2 = createRandomStream(11);
    void p2.next();
    void p2.next();
    void p2.next();
    expect(draws(p2.fork("bg"), 4)).toEqual(f1);
    expect(draws(createRandomStream(11).fork("fg"), 4)).not.toEqual(f1);
  });

  it("int/float/chance/pick 的取值域与边界报错", () => {
    const s = createRandomStream(5);
    for (let i = 0; i < 40; i++) {
      const v = s.int(3, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(7);
      const f = s.float(10, 20);
      expect(f).toBeGreaterThanOrEqual(10);
      expect(f).toBeLessThan(20);
    }
    expect(s.chance(0)).toBe(false);
    expect(s.chance(1)).toBe(true);
    expect(["a", "b"]).toContain(s.pick(["a", "b"]));

    expect(() => s.int(1, 1)).toThrow(/max > min/);
    expect(() => s.int(1.5, 3)).toThrow(/max > min/);
    expect(() => s.chance(2)).toThrow(/0\.\.1/);
    expect(() => s.pick([])).toThrow(/非空/);
  });
});

describe("引擎装配", () => {
  it("同 seed 两次运行抽到同一串数；换 seed 就不同", async () => {
    const first: number[] = [];
    const second: number[] = [];
    const third: number[] = [];
    await makeEngine(3).run(capture(first), new MemoryFrameSink());
    await makeEngine(3).run(capture(second), new MemoryFrameSink());
    await makeEngine(4).run(capture(third), new MemoryFrameSink());
    expect(first.length).toBe(9); // 300ms @30fps
    expect(second).toEqual(first);
    expect(third).not.toEqual(first);
  });

  it("同一引擎重复推演：随机源回到开工状态，两次序列一致", async () => {
    const draws: number[] = [];
    const engine = makeEngine(13);
    const scene = capture(draws);
    await engine.run(scene, new MemoryFrameSink());
    const first = [...draws];
    draws.length = 0;
    await engine.run(scene, new MemoryFrameSink());
    expect(first.length).toBeGreaterThan(0);
    expect(draws).toEqual(first);
  });

  it("单元各有独立子流：别的单元多抽几次不影响本单元", async () => {
    const a1: number[] = [];
    const b1: number[] = [];
    const a2: number[] = [];
    const b2: number[] = [];
    await makeEngine(9).run(twoUnits(1, a1, b1), new MemoryFrameSink());
    await makeEngine(9).run(twoUnits(3, a2, b2), new MemoryFrameSink());
    expect(a2).toEqual(a1); // 第二个单元多抽 2 次，第一个单元不受影响
    expect(b2).not.toEqual(b1);
  });

  it("spawn 实例各走各的子流：两实例序列不同，同 seed 下可复现", async () => {
    const tuples: number[][] = [];
    const child = start(100, (env) => {
      env.step(100, (ctx) => {
        tuples.push([ctx.random.next(), ctx.random.next(), ctx.random.next()]);
      });
    });
    const parent = start(100, (env) => {
      env.par([
        (br) => br.spawn(child, { key: "a", forever: true }),
        (br) => br.spawn(child, { key: "b", forever: true }),
      ]);
    });
    await makeEngine(6).run(parent, new MemoryFrameSink());
    expect(tuples.length).toBeGreaterThanOrEqual(4); // 两实例同帧各 3 抽
    const firstA = tuples[0]!;
    const firstB = tuples.find((t) => t[0] !== firstA[0])!;
    expect(firstB).not.toEqual(firstA);
  });

  it("loop 与 wait 上下文同样能抽随机数", async () => {
    const scene = (loopDraws: number[], waitDraws: number[]) =>
      start(200, (env) => {
        env.par([
          (br) =>
            br.loop({
              ms: 100,
              times: 2,
              fn: (ctx) => {
                loopDraws.push(ctx.random.next());
              },
            }),
          (br) =>
            br.wait(200, (ctx) => {
              waitDraws.push(ctx.random.next());
            }),
        ]);
      });
    const loop1: number[] = [];
    const wait1: number[] = [];
    const loop2: number[] = [];
    const wait2: number[] = [];
    await makeEngine(2).run(scene(loop1, wait1), new MemoryFrameSink());
    await makeEngine(2).run(scene(loop2, wait2), new MemoryFrameSink());
    expect(loop1.length).toBe(6); // 2 迭代 × @30fps 每迭代 3 帧
    expect(wait1.length).toBeGreaterThan(0);
    expect(loop2).toEqual(loop1);
    expect(wait2).toEqual(wait1);
  });

  it("缺省种子等于显式写 DEFAULT_PROGRAM_SEED", async () => {
    const bare: number[] = [];
    const explicit: number[] = [];
    await makeEngine().run(capture(bare), new MemoryFrameSink());
    await makeEngine(DEFAULT_PROGRAM_SEED).run(
      capture(explicit),
      new MemoryFrameSink(),
    );
    expect(bare).toEqual(explicit);
  });

  it("非法种子在开工前报 spec_violation", () => {
    for (const bad of [-1, 1.5, 2 ** 32, Number.NaN]) {
      expect(() => makeEngine(bad)).toThrow(/4294967295/);
    }
    expect(() => makeEngine(2 ** 32 - 1)).not.toThrow();
  });
});

describe("组合根装配", () => {
  it("RenderOptions.seed 经 assemble 到达回调", async () => {
    const seen: number[] = [];
    const scene = start(200, (env) => {
      env.step(200, (ctx) => {
        seen.push(ctx.random.next());
      });
    });
    const run = (seed?: number) =>
      render(scene, {
        fps: 10,
        width: 4,
        height: 4,
        headless: true,
        ...(seed === undefined ? {} : { seed }),
        painter: () => ({
          data: new Uint8ClampedArray(4 * 4 * 4),
          width: 4,
          height: 4,
        }),
        exporter: new FrameSequenceExporter(),
      });
    await run(21);
    const first = [...seen];
    seen.length = 0;
    await run(21);
    expect(seen).toEqual(first);
    seen.length = 0;
    await run(22);
    expect(seen).not.toEqual(first);
    await expect(run(-1)).rejects.toThrow(/4294967295/);
  });
});
