/**
 * 离线混音端变速铺轨：变速 = 磁带式重采样，逐样本断言源位置，
 * 覆盖 2 倍速、srcMs:"end" 填满区间与变速 loop 回卷。
 */
import { describe, expect, it } from "vitest";
import { warp as warpOf } from "@lingfan-video/core";
import { left, makeMixer, rampPcm, voice } from "./audio-warp-fixtures";

describe("离线混音端变速铺轨", () => {
  it("2 倍速：输出帧 i 取源位置 2i（磁带式重采样）", async () => {
    const mixer = makeMixer(rampPcm(100));
    const [sample] = await mixer.renderProgram({
      durationMs: 200,
      voices: [voice(0, { rate: warpOf([0, 0], [25, 50]) })],
    });
    const data = sample!.data;
    expect(left(data, 0)).toBe(0);
    expect(left(data, 1200)).toBeCloseTo(2400, 0); // 25ms 处 → 源 50ms
    expect(left(data, 2399)).toBeCloseTo(4798, 0); // 末帧 → 源 4798
    expect(left(data, 2400)).toBe(0); // 100ms 源在 2 倍速下 50ms 播完
    expect(left(data, 4800)).toBe(0);
  });

  it('srcMs:"end" 填满事件区间：事件尾正好落在源尾，其后静音', async () => {
    const mixer = makeMixer(rampPcm(1000));
    const [sample] = await mixer.renderProgram({
      durationMs: 600,
      voices: [voice(0, { rate: warpOf([0, 0], [400, "end"]) })],
    });
    const data = sample!.data;
    expect(left(data, 19_199)).toBeGreaterThan(47_000);
    expect(left(data, 19_200)).toBe(0);
    expect(left(data, 28_799)).toBe(0);
  });

  it("变速 loop：在源空间回卷（零点周期随时间线速率变化）", async () => {
    const mixer = makeMixer(rampPcm(100));
    const [sample] = await mixer.renderProgram({
      durationMs: 200,
      voices: [
        voice(0, {
          loop: { untilMs: undefined },
          rate: warpOf([0, 0], [50, 100]),
        }),
      ],
    });
    const data = sample!.data;
    expect(left(data, 25 * 48)).toBeGreaterThan(2000); // 25ms → 源 50ms
    expect(left(data, 50 * 48)).toBeCloseTo(0, 0); // 回卷点
    expect(left(data, 75 * 48)).toBeGreaterThan(2000); // 第二圈
  });
});
