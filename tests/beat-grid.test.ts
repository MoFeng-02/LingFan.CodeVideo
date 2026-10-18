/**
 * 拍网格：把 BPM 换算成时间线毫秒（纯函数，登记期一次展开）。
 * 覆盖：拍长、细分、起点与偏移、count/untilMs 两种上界、非法参数。
 */
import { describe, expect, it } from "vitest";
import { beatGrid, msPerBeat } from "@lingfan-video/core";

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("期望抛错，实际没有");
}

describe("拍长", () => {
  it("按 60000/bpm 换算（120 BPM = 500ms）", () => {
    expect(msPerBeat(120)).toBe(500);
    expect(msPerBeat(60)).toBe(1000);
    expect(msPerBeat(90)).toBeCloseTo(666.6667, 4);
  });

  it("非法 BPM 报 spec_violation", () => {
    for (const bad of [0, -120, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorOf(() => msPerBeat(bad)).name).toBe("SpecViolation");
    }
  });
});

describe("拍网格", () => {
  it("默认整拍、从 0 起、count 个点", () => {
    expect(beatGrid({ bpm: 120, count: 5 })).toEqual([
      0, 500, 1000, 1500, 2000,
    ]);
  });

  it("细分把一拍切成等长格（半拍 250ms、四分之一拍 125ms）", () => {
    expect(beatGrid({ bpm: 120, count: 4, subdivision: 2 })).toEqual([
      0, 250, 500, 750,
    ]);
    expect(beatGrid({ bpm: 120, count: 3, subdivision: 4 })).toEqual([
      0, 125, 250,
    ]);
  });

  it("from 平移起点、offsetMs 做后置拍", () => {
    expect(beatGrid({ bpm: 120, count: 3, from: 100 })).toEqual([
      100, 600, 1100,
    ]);
    expect(beatGrid({ bpm: 120, count: 3, from: 100, offsetMs: 50 })).toEqual([
      150, 650, 1150,
    ]);
  });

  it("untilMs 上界只保留严格小于它的点", () => {
    expect(beatGrid({ bpm: 120, untilMs: 1000 })).toEqual([0, 500]);
    expect(beatGrid({ bpm: 120, untilMs: 1001 })).toEqual([0, 500, 1000]);
    expect(beatGrid({ bpm: 120, untilMs: 0 })).toEqual([]);
  });

  it("网格点严格递增且精确到整数毫秒（120 BPM 无浮点误差）", () => {
    const grid = beatGrid({ bpm: 120, count: 9, subdivision: 4 });
    expect(grid).toHaveLength(9);
    for (let i = 1; i < grid.length; i++)
      expect(grid[i]!).toBeGreaterThan(grid[i - 1]!);
    for (const t of grid) expect(Number.isInteger(t)).toBe(true);
  });

  it("count 与 untilMs 必须给且只给一个，其余参数非法即报错", () => {
    expect(errorOf(() => beatGrid({ bpm: 120 })).name).toBe("SpecViolation");
    expect(
      errorOf(() => beatGrid({ bpm: 120, count: 2, untilMs: 1000 })).name,
    ).toBe("SpecViolation");
    expect(errorOf(() => beatGrid({ bpm: 120, count: 0 })).name).toBe(
      "SpecViolation",
    );
    expect(
      errorOf(() => beatGrid({ bpm: 120, count: 2, subdivision: 0 })).name,
    ).toBe("SpecViolation");
    expect(errorOf(() => beatGrid({ bpm: 120, count: 2, from: -1 })).name).toBe(
      "SpecViolation",
    );
    expect(
      errorOf(() => beatGrid({ bpm: 120, count: 2, offsetMs: -1 })).name,
    ).toBe("SpecViolation");
  });
});
