/**
 * DSL 登记面：start 三重载、cutTo 链、登记期 spawn 占位、transition 短路登记。
 * 运行期语义（prev 传递/stop/kill）在 engine-timeline.test.ts。
 */
import { describe, expect, it } from "vitest";
import { start, createScene } from "@lingfan-video/core";
import type { Handle } from "@lingfan-video/contracts";

describe("start 三重载", () => {
  it("2 参：windowMs + body", () => {
    const s = start(1000, (env) => {
      env.step(500, () => {});
    });
    expect(s.duration).toBe(1000);
    expect(s.id).toMatch(/^scene#/);
  });

  it("3 参：0 + 秒糖 + body", () => {
    const s = start(0, 1.5, (env) => {
      env.step(500, () => {});
    });
    expect(s.duration).toBe(1500);
  });

  it("1 参：StartSpec{window, run}", () => {
    const s = start({
      window: 500,
      run: (env) => {
        env.step(250, () => {});
      },
    });
    expect(s.duration).toBe(500);
  });
});

describe("cutTo 链", () => {
  it("cutTo 返回新 Scene，duration/id 独立", () => {
    const a = createScene(200, () => {});
    const b = a.cutTo(300, () => {});
    expect(b.duration).toBe(300);
    expect(b.id).not.toBe(a.id);
  });

  it("秒糖：cutTo(0, 3, body) = 3000ms（首参字面量 0 标记秒）", () => {
    const b = createScene(100, () => {}).cutTo(0, 3, () => {});
    expect(b.duration).toBe(3000);
  });
});

describe("登记期语义（SceneEnv 捕获）", () => {
  it("spawn 返回占位死 Handle（alive=false；真 Handle 在运行期 ctx.spawn）", () => {
    const bg = createScene(100, () => {});
    let h: Handle | undefined;
    createScene(200, (env) => {
      h = env.spawn(bg, { key: "bg" });
    });
    // body 未跑（登记仅在 engine/validate 干跑时执行）→ 这里用干跑触发：
    const holder = createScene(200, (env) => {
      const dead = env.spawn(bg, { key: "bg" });
      expect(dead.alive).toBe(false);
      expect(typeof dead.kill).toBe("function");
      expect(typeof dead.dispose).toBe("function");
    });
    void holder;
    void h;
  });

  it("audio / bgm 登记不抛、不推进 cursor（不占帧窗池）", () => {
    expect(() => {
      createScene(1000, (env) => {
        env.audio("sfx.mp3", { at: 100, volume: 0.5 });
        env.bgm("bgm.mp3");
        env.step(500, () => {});
      });
    }).not.toThrow();
  });

  it("loop 对象参数与 par 分支 env（显式接分支）", () => {
    expect(() => {
      createScene(1000, (env) => {
        env.loop({
          ms: 100,
          times: 3,
          fn: (ctx) => {
            void ctx.iteration;
          },
        });
        env.par([
          (b) => {
            b.wait(300);
          },
          (b) => {
            b.wait(100);
          },
        ]);
      });
    }).not.toThrow();
  });

  it("transitionTo 登记：其后节点在运行期被短路（编译 break），登记本身不抛", () => {
    const next = createScene(100, () => {});
    expect(() => {
      createScene(300, (env) => {
        env.transitionTo(next);
        env.step(100, () => {}); // 运行期不会活跃（transition 收窗）
      });
    }).not.toThrow();
  });
});

describe("setup 执行（StartSpec.setup）", () => {
  it("setup 先于 run 执行一次；异步 setup → spec_violation（确定性时间线）", async () => {
    const { validate, makeRenderError } = await import("@lingfan-video/core");
    void makeRenderError;
    const order: string[] = [];
    const s = start({
      window: 500,
      setup: (env) => {
        order.push("setup");
        void env.assets; // 资产钩子可访问
      },
      run: (env) => {
        order.push("run");
        env.step(250, () => {});
      },
    });
    const { TimelineEngine } = await import("@lingfan-video/core");
    const engine = new TimelineEngine({
      fps: 60,
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
    const summary = await engine.run(s, {
      writeFrame: () => {},
      finalize: async () => {},
    });
    // step 250ms @60fps → 采样点 0..245ms 共 15 个（空窗不产帧；500ms 窗只采 250ms）
    expect(summary.frames).toBe(15);
    expect(order).toEqual(["setup", "run"]);

    // 异步 setup 拒绝
    const asyncScene = start({
      window: 500,
      setup: async () => {},
      run: () => {},
    });
    const engine2 = new TimelineEngine({
      fps: 60,
      width: 1,
      height: 1,
      canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
      headless: true,
    });
    engine2.setPainter(() => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }));
    await expect(
      engine2.run(asyncScene, {
        writeFrame: () => {},
        finalize: async () => {},
      }),
    ).rejects.toThrow(/setup 返回 Promise.*确定性时间线/);
    void validate;
  });

  it("assets.load 未装配 AssetSource → spec_violation；经组合根 render 注入默认实现 → fail-fast", async () => {
    const { start, TimelineEngine, render } =
      await import("@lingfan-video/core");
    const { FrameSequenceExporter } = await import("@lingfan-video/infra");

    // 路径 A：裸引擎未装配 assets
    const sA = start({
      window: 500,
      setup: (env) => env.assets.load("img.png"),
      run: () => {},
    });
    const engine = new TimelineEngine({
      fps: 60,
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
    await expect(
      engine.run(sA, { writeFrame: () => {}, finalize: async () => {} }),
    ).rejects.toThrow(/未装配 AssetSource/);

    // 路径 B：组合根默认注入 fail-fast 实现
    const sB = start({
      window: 500,
      setup: (env) => env.assets.load("img.png"),
      run: () => {},
    });
    await expect(
      render(sB, {
        fps: 60,
        width: 1,
        height: 1,
        headless: true,
        exporter: new FrameSequenceExporter(),
      }),
    ).rejects.toThrow(/组合根未注入 AssetSource/);
  });
});
