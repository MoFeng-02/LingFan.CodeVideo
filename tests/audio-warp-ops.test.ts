/**
 * 运行期操作对声音求值的影响：setRate 切分积分、stop 淡出终点、
 * setGain 折线过渡，以及 loop 到总时间线尾的截断。
 */
import { describe, expect, it } from "vitest";
import { evaluateVoice } from "@lingfan-video/infra";
import { voice } from "./audio-warp-fixtures";

describe("运行期操作（voice 求值：setRate / stop / setGain）", () => {
  const src = 1000;

  it("setRate：前半原速、200ms 处切 2 倍速（斜率切分后源位置积分）", () => {
    const v = voice(0, {
      ops: [{ kind: "rate", atMs: 200, value: 2, rampMs: 0 }],
    });
    const tl = evaluateVoice(v, src, 10_000);
    expect(tl.sourceMsAt(100)).toBe(100);
    expect(tl.sourceMsAt(300)).toBeCloseTo(400, 6); // 200 + (300-200)*2
    // 源 1000ms 播完 = 200 + 800/2 = 600ms
    expect(tl.endMs).toBeCloseTo(600, 6);
  });

  it("setRate 带 rampMs：速率在窗口内线性爬升，源位置按二次段积分", () => {
    const v = voice(0, {
      ops: [{ kind: "rate", atMs: 200, value: 2, rampMs: 100 }],
    });
    const tl = evaluateVoice(v, src, 10_000);
    expect(tl.rateAt(150)).toBeCloseTo(1, 6);
    expect(tl.rateAt(250)).toBeCloseTo(1.5, 6); // 爬坡中点
    expect(tl.rateAt(350)).toBeCloseTo(2, 6);
    // 源位置：0..200 匀速 1 = 200；200..250 梯形积分 = 62.5；250..350 匀速 2 = 200
    expect(tl.sourceMsAt(250)).toBeCloseTo(262.5, 6);
    expect(tl.sourceMsAt(350)).toBeCloseTo(450, 6);
  });

  it("stop(fadeOut)：终点提前，增益在淡出区间线性归零", () => {
    const v = voice(0, {
      ops: [{ kind: "stop", atMs: 300, fadeMs: 100 }],
    });
    const tl = evaluateVoice(v, src, 10_000);
    expect(tl.endMs).toBe(300);
    expect(tl.gainAt(199)).toBeCloseTo(1, 6);
    expect(tl.gainAt(250)).toBeCloseTo(0.5, 2);
    expect(tl.gainAt(300)).toBe(0);
  });

  it("setGain：按时段改增益（折线单调过渡）", () => {
    const v = voice(0, {
      ops: [{ kind: "gain", atMs: 200, value: 0.2, rampMs: 100 }],
    });
    const tl = evaluateVoice(v, src, 10_000);
    expect(tl.gainAt(100)).toBeCloseTo(1, 6);
    expect(tl.gainAt(250)).toBeCloseTo(0.6, 6);
    expect(tl.gainAt(300)).toBeCloseTo(0.2, 6);
  });

  it("loop 到终界：endMs 夹在总时间线尾（引擎不因幕边界杀声音）", () => {
    const v = voice(0, { loop: {} });
    const tl = evaluateVoice(v, src, 250);
    expect(tl.endMs).toBe(250);
    expect(tl.sourceMsAt(10)).toBeCloseTo(10); // 曲内正常取源
    // 越过终界不再前进（声音已停，位置保持在终点处）
    expect(tl.sourceMsAt(1000)).toBeCloseTo(tl.sourceMsAt(250));
  });
});
