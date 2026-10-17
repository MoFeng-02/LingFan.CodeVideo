/**
 * 时间数学：timestampAt 乘法禁累加、确定性换算。
 */
import { describe, expect, it } from "vitest";
import {
  framesToMs,
  frameCount,
  msToFrames,
  timestampAt,
} from "@lingfan-video/core";

describe("time-math（乘法禁累加）", () => {
  it("timestampAt = frameIndex * (1000/fps)，恒等乘法", () => {
    expect(timestampAt(0, 60)).toBe(0);
    expect(timestampAt(30, 30)).toBe(1000); // 30fps 第 30 帧 = 1000ms
    expect(timestampAt(60, 60)).toBe(1000);
    expect(timestampAt(1, 30)).toBeCloseTo(33.3333, 3); // 1000/30 非整
  });

  it("乘法与累加在 fps 不整除时不同（乘法是唯一正解）", () => {
    // 30fps：若逐帧 += 33.33 累加，30 帧后 = 999.9 ≠ 1000
    let acc = 0;
    for (let i = 0; i < 30; i++) acc += 1000 / 30;
    expect(acc).not.toBe(timestampAt(30, 30));
  });

  it("msToFrames = floor(ms*fps/1000)", () => {
    expect(msToFrames(1000, 60)).toBe(60);
    expect(msToFrames(999, 60)).toBe(59); // floor(59.94)
    expect(msToFrames(0, 60)).toBe(0);
    expect(msToFrames(1, 30)).toBe(0); // floor(0.03)
  });

  it("framesToMs 与 timestampAt 恒等", () => {
    for (let i = 0; i <= 90; i++) {
      expect(framesToMs(i, 60)).toBe(timestampAt(i, 60));
    }
  });

  it("frameCount 是 msToFrames 别名", () => {
    expect(frameCount(2500, 60)).toBe(msToFrames(2500, 60));
    expect(frameCount(2500, 60)).toBe(150);
  });
});
