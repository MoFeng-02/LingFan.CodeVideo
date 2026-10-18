/**
 * warp 解析与求值：锚点表 → 源时间映射，覆盖恒等、匀速、斜率延续、
 * 中途恢复、srcMs:"end" 填满区间、隐式原点与逆映射互逆。
 */
import { describe, expect, it } from "vitest";
import {
  rateSegments,
  resolveWarp,
  sourceMsAt,
  timelineMsAtSource,
} from "@lingfan-video/infra";

describe("warp 解析与求值（映射表）", () => {
  it("省略 warp = 原速恒等映射（源时间 = 时间线时间）", () => {
    const w = resolveWarp(undefined, 1000);
    expect(w.points).toEqual([{ atMs: 0, srcMs: 0 }]);
    expect(sourceMsAt(w, 250)).toBe(250);
    expect(timelineMsAtSource(w, 250)).toBe(250);
    expect(rateSegments(w)).toEqual([{ fromMs: 0, rate: 1 }]);
  });

  it("两个锚点 = 匀速加速，斜率即速率", () => {
    const w = resolveWarp(
      [
        { atMs: 0, srcMs: 0 },
        { atMs: 500, srcMs: 1000 },
      ],
      4000,
    );
    expect(sourceMsAt(w, 250)).toBe(500); // 2 倍速
    expect(sourceMsAt(w, 500)).toBe(1000);
    expect(timelineMsAtSource(w, 500)).toBe(250);
    expect(rateSegments(w)).toEqual([{ fromMs: 0, rate: 2 }]);
  });

  it("不给恢复锚点 = 加速后一直保持（斜率延续到事件尾）", () => {
    const w = resolveWarp(
      [
        { atMs: 0, srcMs: 0 },
        { atMs: 500, srcMs: 1000 },
      ],
      4000,
    );
    expect(sourceMsAt(w, 600)).toBe(1200);
    expect(sourceMsAt(w, 1000)).toBe(2000);
  });

  it("插回原速锚点 = 中途加速后恢复", () => {
    const w = resolveWarp(
      [
        { atMs: 0, srcMs: 0 },
        { atMs: 500, srcMs: 1000 },
        { atMs: 1000, srcMs: 1500 },
      ],
      4000,
    );
    expect(rateSegments(w)).toEqual([
      { fromMs: 0, rate: 2 },
      { fromMs: 500, rate: 1 },
    ]);
    expect(sourceMsAt(w, 750)).toBe(1250);
    expect(sourceMsAt(w, 1500)).toBe(2000);
  });

  it('srcMs:"end" = 把整段源拉伸/压缩到恰好填满锚点区间（自然收尾）', () => {
    const w = resolveWarp(
      [
        { atMs: 0, srcMs: 0 },
        { atMs: 400, srcMs: "end" },
      ],
      1000,
    );
    expect(w.points[1]!.srcMs).toBe(1000);
    expect(sourceMsAt(w, 400)).toBe(1000);
    expect(timelineMsAtSource(w, 1000)).toBe(400);
    expect(rateSegments(w)).toEqual([{ fromMs: 0, rate: 2.5 }]);
  });

  it("首锚点晚于 0：其前由隐式原点线性插值（不是跳变，斜率一致）", () => {
    const w = resolveWarp([{ atMs: 200, srcMs: 400 }], 4000);
    expect(w.points[0]).toEqual({ atMs: 0, srcMs: 0 });
    expect(sourceMsAt(w, 100)).toBe(200);
    expect(sourceMsAt(w, 400)).toBe(800);
  });

  it("逆映射与正映射互逆（含斜率延续段）", () => {
    const w = resolveWarp(
      [
        { atMs: 0, srcMs: 0 },
        { atMs: 300, srcMs: 900 },
        { atMs: 700, srcMs: 1200 },
      ],
      5000,
    );
    for (const t of [0, 120, 300, 455, 700, 1500]) {
      expect(timelineMsAtSource(w, sourceMsAt(w, t))).toBeCloseTo(t, 6);
    }
  });
});
