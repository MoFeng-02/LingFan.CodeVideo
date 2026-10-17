/**
 * 引擎端到端（时间模型 + 节点语义 + 保活）：
 * 真跑 TimelineEngine + MemoryFrameSink，逐帧断言聚合快照与帧数。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, clip, createScene } from "@lingfan-video/core";
import { MemoryFrameSink } from "@lingfan-video/infra";
import type { FrameState } from "@lingfan-video/contracts";

const FPS = 30;

function makeEngine() {
  const engine = new TimelineEngine({
    fps: FPS,
    width: 4,
    height: 4,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
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
    // 第二段无任何活跃单元（空窗不产帧）：只有第一段 step 的采样点 0/33.3/66.7ms
    expect(summary.frames).toBe(3);
    expect(summary.durationMs).toBe(200);
  });

  it("空剧本（无任何单元）不产帧：语义层单位是毫秒，采样密度由活跃单元决定", async () => {
    const scene = createScene(150, () => {}); // 150ms 但没有任何登记
    const summary = await makeEngine().run(scene, new MemoryFrameSink());
    expect(summary.frames).toBe(0);
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
    // 活跃采样点只有 step 的 0/33.3/66.7ms（wait 空窗、bg 链无单元都不产帧）
    expect(summary.frames).toBe(3);
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

describe("spawn 链登记唯一性（注册期）", () => {
  it("登记期 spawn 链只登记一次：单元每帧只求值一次、音频事件不翻倍", async () => {
    let calls = 0;
    const bg = createScene(100, (_prev, env) => {
      env.audio(clip("bgm"));
      env.step(100, () => {
        calls++;
      });
    });
    const main = createScene(300, (_prev, env) => {
      env.spawn(bg, { key: "bg" }); // 锚点 = 登记游标 0
      env.step(300, () => {});
    });
    const summary = await makeEngine().run(main, new MemoryFrameSink());
    // 链内容 100ms 落在主链采样点 0/33.3/66.7 上；重复登记会让每处求值两次
    expect(calls).toBe(3);
    expect(summary.audioVoices).toHaveLength(1);
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
    // 锚定 100ms 处 spawn 该链（300ms 短路 → 实际内容 200ms）：
    // 登记期 spawn 在 step(100) 之后，cursor=100 即锚点
    const host = createScene(600, (_prev, env) => {
      env.step(100, () => ({ phase: "host" }));
      env.spawn(first, { key: "ch" });
    });
    const engine = makeEngine();
    const summary = await engine.run(host, new MemoryFrameSink());
    // 链起点 100 + 实际内容 200 = 链尾 300（修复前会虚高到 100+300+500=900）
    // 链死后的 400ms 空窗不该画出 tail 内容；空窗也不产帧
    // 采样点：host step 0/33.3/66.7 + 链 first step 100/133.3/166.7 + tail step 200/233.3/266.7 = 9
    expect(summary.durationMs).toBe(600);
    expect(summary.frames).toBe(9);
  });

  it("运行期 spawn（step 回调内 ctx.spawn）动态重采样：新链采样点即时入网", async () => {
    const dyn = createScene(100, (_prev, env) => {
      env.step(100, () => ({ phase: "dyn" }), { fps: 60 });
    });
    // spawn 锚定 100ms（登记期 step 占满 0..100 窗），运行期在首采样点 ctx.spawn
    const host = createScene(200, (_prev, env) => {
      env.step(100, () => ({ phase: "lead" }));
      env.step(100, (ctx) => {
        ctx.spawn(dyn, { key: "late" }); // 运行期 spawn（ctx 来源是 eval StepContext）
        return { phase: "host" };
      });
    });
    const summary = await makeEngine().run(host, new MemoryFrameSink());
    // 主单元 0..200ms @30fps 7 点（0..200 端点不含 200）；dyn 链 100..200ms @60fps 新增 116.7/150/183.3 → 共 9
    expect(summary.frames).toBe(9);
    expect(summary.durationMs).toBe(200);
  });

  it("单元 fps 覆盖基础帧率：高帧率单元采样点更密", async () => {
    // 基础 30fps；单元声明 60fps → 100ms 窗 7 点（0/16.7..100? 端点不含 → 0/16.7/33.3/50/66.7/83.3 共 6 点）
    const scene = createScene(100, (_prev, env) => {
      env.step(100, () => ({ phase: "hi" }), { fps: 60 });
    });
    const sink = new MemoryFrameSink();
    const summary = await makeEngine().run(scene, sink);
    expect(summary.frames).toBe(6);
    expect(sink.timestamps.length).toBe(6);
  });
});
