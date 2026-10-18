/**
 * 层调度是推演语义的一部分：什么时候显示哪一层，必须能被断言、也必须可复现。
 * 这里测纯函数，不需要 GPU / 画布——所以它在 CI（Node）里也跑。
 */
import { describe, expect, it } from "vitest";
import type { FrameIndex, Ms } from "@lingfan-video/contracts";
import { isLayerActive, planComposite } from "@lingfan-video/infra";
import type { FrameLayer, LayerSpec } from "@lingfan-video/infra";

function layer(spec: LayerSpec, id = spec.id): FrameLayer {
  return {
    spec,
    surface: {
      id,
      width: 8,
      height: 8,
      canvas: { width: 8, height: 8 } as unknown as HTMLCanvasElement,
      render(_frame: FrameIndex, _t: Ms) {},
    },
  };
}

describe("帧合成：层的可见区间与叠放次序", () => {
  it("缺省区间=全程可见；给了边界就左闭右开", () => {
    const forever: LayerSpec = { id: "bed" };
    expect(isLayerActive(forever, -1)).toBe(true);
    expect(isLayerActive(forever, 1_000_000)).toBe(true);

    const window: LayerSpec = { id: "glow", from: 300, to: 900 };
    expect(isLayerActive(window, 299.9)).toBe(false);
    expect(isLayerActive(window, 300)).toBe(true); // 左闭
    expect(isLayerActive(window, 899.9)).toBe(true);
    expect(isLayerActive(window, 900)).toBe(false); // 右开
  });

  it("只叠本帧可见的层，按 z 升序（z 相同保持声明顺序）", () => {
    const a = layer({ id: "a", z: 2 });
    const b = layer({ id: "b", from: 0, to: 500, z: 0 });
    const c = layer({ id: "c", z: 1 });
    const d = layer({ id: "d", z: 1 });

    expect(planComposite([a, b, c, d], 100).map((l) => l.spec.id)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
    // 过了 b 的边界，叠放结果只剩三层，次序不变
    expect(planComposite([a, b, c, d], 500).map((l) => l.spec.id)).toEqual([
      "c",
      "d",
      "a",
    ]);
  });

  it("同一时刻的叠放次序与声明顺序无关（只由 z 与声明次序决定）", () => {
    const first = planComposite(
      [layer({ id: "x", z: 1 }), layer({ id: "y", z: 3 })],
      0,
    ).map((l) => l.spec.id);
    const second = planComposite(
      [layer({ id: "x", z: 1 }), layer({ id: "y", z: 3 })],
      0,
    ).map((l) => l.spec.id);
    expect(first).toEqual(second);
    expect(first).toEqual(["x", "y"]);
  });
});
