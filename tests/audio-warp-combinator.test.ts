/**
 * warp 组合子（构造期校验）：合法锚点建出强类型值；非法锚点与越界量纲
 * 在构造处即报 SpecViolation（不等到求值或导出）。
 */
import { describe, expect, it } from "vitest";
import {
  gain as gainOf,
  rate as rateOf,
  warp as warpOf,
} from "@lingfan-video/core";

describe("warp 组合子（构造期校验）", () => {
  const catchIt = (fn: () => unknown): string => {
    try {
      fn();
      return "no-throw";
    } catch (e) {
      return (e as Error).name;
    }
  };

  it("合法锚点建出 {kind:'warp'} 强类型值", () => {
    const r = warpOf([0, 0], [600, 1200], [1000, "end"]);
    expect(r.kind).toBe("warp");
    expect(r.kind === "warp" && r.points).toEqual([
      { atMs: 0, srcMs: 0 },
      { atMs: 600, srcMs: 1200 },
      { atMs: 1000, srcMs: "end" },
    ]);
  });

  it("非法锚点在构造处即报 SpecViolation（时间不递增 / 源不递增 / end 非末位 / 空表）", () => {
    expect(catchIt(() => warpOf([100, 0], [100, 50]))).toBe("SpecViolation");
    expect(catchIt(() => warpOf([0, 100], [100, 100]))).toBe("SpecViolation");
    expect(catchIt(() => warpOf([0, 0], [50, "end"], [100, 200]))).toBe(
      "SpecViolation",
    );
    expect(catchIt(() => warpOf())).toBe("SpecViolation");
  });

  it("其它组合子守住量纲与范围（rate>0 / pan∈[-1,1] / gain≥0）", () => {
    expect(catchIt(() => rateOf(0))).toBe("SpecViolation");
    expect(catchIt(() => rateOf(-1))).toBe("SpecViolation");
    expect(catchIt(() => warpOf([0, 10], [10, 5]))).toBe("SpecViolation"); // 源不递增 = 倒放
    expect(catchIt(() => gainOf(-0.1))).toBe("SpecViolation");
  });
});
