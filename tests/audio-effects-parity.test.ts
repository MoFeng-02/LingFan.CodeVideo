/**
 * 效果链在单一内核里的行为：延迟的时序量化、反馈衰减、干湿比例，
 * 以及混响的确定性与尾音随房间变大而变长。两端跑同一份实现，这里检查实现本身。
 */
import { describe, expect, it } from "vitest";
import type { AudioGraph } from "@lingfan-video/contracts";
import {
  SR,
  energy,
  graphOf,
  peakIndex,
  renderImpulse,
} from "./support/audio-probes";

function peak(data: Float32Array, atSample: number): number {
  return Math.abs(data[atSample * 2]!);
}

describe("效果：延迟", () => {
  it("延时量落实到样本：max(1, round(ms × SR / 1000))", () => {
    for (const ms of [180, 180.3, 7.77, 1, 0.5]) {
      const graph = graphOf([
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs: ms, feedback: 0, mix: 1 }],
        },
      ]);
      const out = renderImpulse(graph, { frames: SR });
      expect(peakIndex(out)).toBe(Math.max(1, Math.round((ms * SR) / 1000)));
    }
  });

  it("反馈逐级乘系数：0.35^k，且两个声道各自独立", () => {
    const graph = graphOf([
      {
        id: "fx",
        effects: [{ kind: "delay", delayMs: 10, feedback: 0.35, mix: 1 }],
      },
    ]);
    const out = renderImpulse(graph, { frames: SR / 4 });
    const lag = Math.round((10 * SR) / 1000);
    expect(peak(out, 0)).toBeLessThan(1e-6);
    let previous = 1;
    for (let k = 1; k <= 4; k++) {
      // 首回声就是干声本身（mix=1），之后每绕一圈乘一次反馈系数
      const tap = peak(out, lag * k);
      expect(tap).toBeCloseTo(previous, 6);
      previous = tap * 0.35;
    }
    for (let i = 0; i < out.length / 2; i++)
      expect(out[i * 2 + 1]).toBe(out[i * 2]!);
  });

  it("干湿比例：mix=0 只留干声，mix=1 只剩湿声", () => {
    const dry = renderImpulse(
      graphOf([
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs: 50, feedback: 0, mix: 0 }],
        },
      ]),
      { frames: SR / 4 },
    );
    expect(peak(dry, 0)).toBeCloseTo(1, 6);
    expect(peak(dry, Math.round((50 * SR) / 1000))).toBeLessThan(1e-6);
    const wet = renderImpulse(
      graphOf([
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs: 50, feedback: 0, mix: 1 }],
        },
      ]),
      { frames: SR / 4 },
    );
    expect(peak(wet, 0)).toBeLessThan(1e-6);
    expect(peak(wet, Math.round((50 * SR) / 1000))).toBeCloseTo(1, 6);
  });
});

describe("效果：混响", () => {
  it("同一图两次渲染逐样本相同，输入结束后仍有尾音", () => {
    const graph: AudioGraph = graphOf([
      {
        id: "fx",
        effects: [{ kind: "reverb", roomSize: 0.7, damping: 0.4, mix: 1 }],
      },
    ]);
    const a = renderImpulse(graph, { frames: SR });
    const b = renderImpulse(graph, { frames: SR });
    expect(a.length).toBe(b.length);
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
    expect(diff).toBe(0);
    expect(energy(a, 400, 900)).toBeGreaterThan(0.5);
  });

  it("房间越大人声尾越长：尾段能量随 roomSize 递增", () => {
    const small = renderImpulse(
      graphOf([
        { id: "fx", effects: [{ kind: "reverb", roomSize: 0.2, mix: 1 }] },
      ]),
      { frames: SR * 2 },
    );
    const large = renderImpulse(
      graphOf([
        { id: "fx", effects: [{ kind: "reverb", roomSize: 0.85, mix: 1 }] },
      ]),
      { frames: SR * 2 },
    );
    expect(energy(large, 700, 1500)).toBeGreaterThan(energy(small, 700, 1500));
  });
});
