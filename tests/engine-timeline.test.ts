/**
 * 引擎端到端（时间模型 + 节点语义 + 保活）：
 * 真跑 TimelineEngine + MemoryFrameSink，逐帧断言聚合快照与帧数。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, createScene } from "@lingfan-video/core";
import { MemoryFrameSink } from "@lingfan-video/infra";
import type { FrameState } from "@lingfan-video/contracts";

const FPS = 30;

function makeEngine() {
  const engine = new TimelineEngine({
    fps: FPS,
    width: 4,
    height: 4,
    canvas: null,
    headless: true,
  });
  // 组合根（assemble）的职责在测试里手动复刻：CPU 占位 painter，全 0 位图
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(4 * 4 * 4),
    width: 4,
    height: 4,
  }));
  return engine;
}

describe("链式推进与 prev 传递", () => {
  it("cutTo 链跑满两段、body 返回值成为下一幕 prev", async () => {
    // cutTo 返回链尾（child），时间线要从 head 起
    const head = createScene(100, (_prev, env) => {
      env.step(100, () => ({ hello: "a" })); // step 返回值进聚合器（key 化）
      return { hello: "a" }; // body 返回值才是下一幕 prev
    });
    const scene = head.cutTo(100, (prev) => {
      expect((prev as FrameState).hello).toBe("a"); // prev 透传断言
    });
    const engine = makeEngine();
    const sink = new MemoryFrameSink();
    const summary = await engine.run(head, sink); // 链要从 head 起，不是 cutTo 返回的链尾
    expect(summary.frames).toBe(6); // floor(200*30/1000)
    expect(summary.durationMs).toBe(200);
  });

  it("帧数换算：durationMs*fps/1000 向下取整", async () => {
    const scene = createScene(150, () => {}); // 150ms @30fps = 4.5 → 4 帧
    const summary = await makeEngine().run(scene, new MemoryFrameSink());
    expect(summary.frames).toBe(4);
  });
});

describe("spawn 链与保活", () => {
  it("跨段背景：forever spawn 存活到时间线尽头", async () => {
    const bg = createScene(100, () => {});
    const main = createScene(300, (_prev, env) => {
      env.spawn(bg, { key: "bg", forever: true });
      env.step(300, () => {});
    });
    const engine = makeEngine();
    const sink = new MemoryFrameSink();
    const summary = await engine.run(main, sink);
    expect(summary.frames).toBe(9); // 300ms @30fps
    // forever 链不提前结束主链：帧数仍由主链决定
    expect(summary.durationMs).toBe(300);
  });

  it("scheduler.kill(key) 杀链：kill 后该 spawn 不再绘制", async () => {
    const bg = createScene(50, () => {});
    let killed = false;
    const main = createScene(200, (_prev, env) => {
      env.spawn(bg, { key: "bg" });
      env.step(100, (ctx) => {
        killed = true;
        ctx.scheduler.kill("bg");
      });
      env.wait(100);
    });
    const engine = makeEngine();
    const sink = new MemoryFrameSink();
    const summary = await engine.run(main, sink);
    expect(killed).toBe(true);
    expect(summary.frames).toBe(6);
  });

  it("同 key 二次 spawn 续接（不重叠新建）", async () => {
    const seg = createScene(100, () => {});
    const main = createScene(300, (_prev, env) => {
      env.spawn(seg, { key: "bg" });
      env.spawn(seg, { key: "bg" }); // 与首个活跃重叠 → 续接
      env.step(300, () => {});
    });
    const summary = await makeEngine().run(main, new MemoryFrameSink());
    expect(summary.frames).toBe(9);
  });
});

describe("聚合快照（key 化）", () => {
  it("publish 键 = sceneId/unitKey；lastState 只含本帧活跃", async () => {
    const scene = createScene(100, (_prev, env) => {
      env.step(100, (ctx) => ({ x: ctx.t }));
    });
    const engine = makeEngine();
    const sink = new MemoryFrameSink();
    const summary = await engine.run(scene, sink);
    expect(summary.frames).toBe(3);
    // lastState 是 full() 终态（含所有历史 publish 的键）
    const keys = Object.keys(summary.lastState);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toContain("scene#"); // `${sceneId}/${unitKey}`
  });
});

describe("loop（三种形式）", () => {
  it("form-2 loop ms×times 迭代数正确", async () => {
    let calls = 0;
    const scene = createScene(300, (_prev, env) => {
      env.loop({
        ms: 100,
        times: 3,
        fn: () => {
          calls++;
        },
      });
    });
    await makeEngine().run(scene, new MemoryFrameSink());
    // 每帧求值活跃迭代单元；100ms×3 @30fps：每迭代 3 帧 → 累计 9 次调用
    expect(calls).toBe(9);
  });

  it("form-3 无 ms：整段一次求值、stop() 提前终结", async () => {
    let calls = 0;
    const scene = createScene(300, (_prev, env) => {
      env.loop({
        fn: (ctx) => {
          calls++;
          if (calls === 2) ctx.stop();
        },
      });
    });
    await makeEngine().run(scene, new MemoryFrameSink());
    expect(calls).toBe(2); // stop 后不再求值
  });
});

describe("transitionTo（提前收窗）", () => {
  it("transition 短路：其后单元不活跃、链跳到 transitionNext", async () => {
    const next = createScene(100, (_prev, env) => {
      env.step(100, () => ({ entered: "next" }));
    });
    const scene = createScene(300, (_prev, env) => {
      env.step(100, () => ({ phase: "main" }));
      env.transitionTo(next);
      env.step(100, () => ({ phase: "never" })); // transition 收窗后不活跃
    });
    const engine = makeEngine();
    const sink = new MemoryFrameSink();
    const summary = await engine.run(scene, sink);
    // 主段 100ms 收窗 + next 100ms = 200ms @30fps = 6 帧
    expect(summary.frames).toBe(6);
  });

  it("spawn 链 transition 短路：链长按实况（不含被短路的尾段），同 key 可在其后立即续接", async () => {
    // 尾段 500ms 会被首段的 transition 短路掉
    const tail = createScene(500, (_prev, env) => {
      env.step(100, () => ({ phase: "tail" }));
    });
    const first = createScene(300, (_prev, env) => {
      env.step(100, () => ({ phase: "first" }));
      env.transitionTo(tail);
    });
    // 锚定 100ms 处 spawn 该链（300ms 短路 → 实际内容 200ms）
    const host = createScene(600, (_prev, env) => {
      env.step(100, () => env.spawn(first, { key: "ch" }));
    });
    const engine = makeEngine();
    const summary = await engine.run(host, new MemoryFrameSink());
    // 链起点 100 + 实际内容 200 = 链尾 300（修复前会虚高到 100+300+500=900）
    // 链死后的 400ms 空窗不该画出 tail 内容：tail 的 step 在 300ms 后不存在
    expect(summary.durationMs).toBe(600);
    expect(summary.frames).toBe(18);
  });
});
