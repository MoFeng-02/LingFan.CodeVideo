/**
 * 池账本 / 校验（契约符合性检查 + 双池账本）。
 * 越窗回归钉：30fps 下 f(90)=3000ms 恰越 [0,3000) 窗。
 */
import { describe, expect, it } from "vitest";
import {
  createScene,
  poolOf,
  loopPool,
  validate,
  makeRenderError,
} from "@lingfan-video/core";
import type { SimNode } from "@lingfan-video/core";

describe("validate（契约符合性检查）", () => {
  it("f(90) 越窗 bug 回归钉：at 越窗 → window_overflow", () => {
    // 3000ms 窗、30fps：env.f(90) = 3000ms 恰好越界（窗 [0,3000)）
    const scene = createScene(3000, (_prev, env) => {
      env.step(100, () => {}, { at: env.f(90) });
    });
    const errors = validate(scene, 30);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.code).toBe("window_overflow");
  });

  it("合法剧本零错误", () => {
    const scene = createScene(1000, (_prev, env) => {
      env.step(500, () => {});
      env.wait(500);
    });
    expect(validate(scene, 60)).toEqual([]);
  });

  it("重复链接（cutTo 两个出口）→ throw spec_violation", () => {
    const a = createScene(1000, () => {});
    const b = a.cutTo(1000, () => {});
    // 第二次 cutTo 同一出口 → 工厂抛（一个出口）
    expect(() => a.cutTo(1000, () => {})).toThrow(/spec_violation|重复链接/);
    expect(b).toBeDefined();
  });

  it("body 干跑抛错 → spec_violation", () => {
    const scene = createScene(1000, () => {
      throw new Error("boom");
    });
    const errors = validate(scene, 60);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("spec_violation");
  });
});

describe("poolOf / loopPool（双池账本）", () => {
  it("池消耗 = Σstep + Σwait + Σpar-max", () => {
    const nodes: SimNode[] = [
      { kind: "step", duration: 100, fn: () => {} },
      { kind: "wait", duration: 200 },
      {
        kind: "par",
        children: [
          [{ kind: "wait", duration: 300 }],
          [{ kind: "wait", duration: 100 }],
        ],
      },
    ];
    expect(poolOf(nodes)).toBe(600); // 100+200+max(300,100)
  });

  it("loop 池：ms×times；无 ms（自管节奏）= 0 不占池", () => {
    expect(loopPool({ ms: 100, times: 3 })).toBe(300);
    expect(loopPool({ ms: 100 })).toBe(100);
    expect(loopPool({})).toBe(0);
  });
});

describe("makeRenderError 工厂", () => {
  it("产出 RenderError 形状（kind/sceneId/cursor/expected/actual）", () => {
    const e = makeRenderError("window_overflow", "scene#0", 123, "x", "a", "b");
    expect(e.kind).toBe("window_overflow");
    expect(e.sceneId).toBe("scene#0");
    expect(e.cursor).toBe(123);
    expect(e.expected).toBe("a");
    expect(e.actual).toBe("b");
  });
});
