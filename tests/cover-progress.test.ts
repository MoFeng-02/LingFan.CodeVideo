/**
 * 过场遮盖进度：绝对时间 → 0..1 的线性折线。
 *
 * 用途是让出幕与入幕读同一个绝对时刻：一个画 `alpha`、另一个画 `1 - alpha`，
 * 切点两侧才连得上。折线本身与帧率、段长都无关，因此可以单独测。
 */
import { describe, expect, it } from "vitest";
import { coverProgress } from "@lingfan-video/core";

describe("coverProgress", () => {
  it("起点之前恒为 0，终点之后恒为 1", () => {
    expect(coverProgress(0, 300, 200)).toBe(0);
    expect(coverProgress(299.99, 300, 200)).toBe(0);
    expect(coverProgress(500, 300, 200)).toBe(1);
    expect(coverProgress(900, 300, 200)).toBe(1);
  });

  it("窗内线性推进，且首尾相接", () => {
    expect(coverProgress(300, 300, 200)).toBe(0);
    expect(coverProgress(370, 300, 200)).toBeCloseTo(0.35, 10);
    expect(coverProgress(400, 300, 200)).toBeCloseTo(0.5, 10);
    expect(coverProgress(499.99, 300, 200)).toBeCloseTo(0.99995, 5);
  });

  it("窗长为 0（或负数）退化成阶跃：到点即满遮", () => {
    expect(coverProgress(299, 300, 0)).toBe(0);
    expect(coverProgress(300, 300, 0)).toBe(1);
    expect(coverProgress(0, 0, -5)).toBe(1);
  });

  it("非有限参数直接报错，不做静默夹取", () => {
    expect(() => coverProgress(Number.NaN, 0, 100)).toThrow(/coverProgress/);
    expect(() => coverProgress(10, Number.POSITIVE_INFINITY, 100)).toThrow(
      /coverProgress/,
    );
    expect(() => coverProgress(10, 0, Number.NaN)).toThrow(/coverProgress/);
  });
});
