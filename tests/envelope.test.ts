/**
 * B5/B6：音量包络（ramp/curve）与淡入淡出语法糖。
 * 求值只有一处（infra `evaluateVoice`）：导出逐样本取 `gainAt`、预览取同一组
 * `gainPoints` 做 AudioParam 自动化——本测试钉住这条同源约定。
 */
import { describe, expect, it } from "vitest";
import { clip, curve, fadeIn, fadeOut, gain, ramp } from "@lingfan-video/core";
import { evaluateVoice } from "@lingfan-video/infra";
import type { AudioGain, AudioVoice } from "@lingfan-video/contracts";

function voiceOf(g: AudioGain, startMs = 1000): AudioVoice {
  return {
    id: "v1",
    clip: clip("beep"),
    startMs,
    gain: g,
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
  };
}

describe("B5 ramp：线性包络，首尾保持", () => {
  it("局部 0 → from、ms → to，中途线性", () => {
    const tl = evaluateVoice(
      voiceOf(gain(1, { envelope: ramp(0, 1, 300) })),
      2000,
      5000,
    );
    expect(tl.gainAt(1000)).toBe(0);
    expect(tl.gainAt(1150)).toBeCloseTo(0.5, 6);
    expect(tl.gainAt(1300)).toBe(1);
    expect(tl.gainAt(2000)).toBe(1);
  });

  it("包络与基础增益相乘", () => {
    const tl = evaluateVoice(
      voiceOf(gain(2, { envelope: ramp(0, 1, 100) })),
      2000,
      5000,
    );
    expect(tl.gainAt(1050)).toBeCloseTo(1, 6);
    expect(tl.gainAt(1100)).toBe(2);
  });

  it("ramp(1,0,300) 是 300ms 降到静音", () => {
    const tl = evaluateVoice(
      voiceOf(gain(1, { envelope: ramp(1, 0, 300) })),
      2000,
      5000,
    );
    expect(tl.gainAt(1000)).toBe(1);
    expect(tl.gainAt(1300)).toBe(0);
    expect(tl.gainAt(1600)).toBe(0);
  });
});

describe("B5 curve：分段线性", () => {
  it("经过每个折点，段内线性、末端保持", () => {
    const tl = evaluateVoice(
      voiceOf(gain(1, { envelope: curve([0, 0], [100, 1], [300, 0.5]) })),
      2000,
      5000,
    );
    expect(tl.gainAt(1000)).toBe(0);
    expect(tl.gainAt(1050)).toBeCloseTo(0.5, 6);
    expect(tl.gainAt(1100)).toBe(1);
    expect(tl.gainAt(1200)).toBeCloseTo(0.75, 6);
    expect(tl.gainAt(1300)).toBe(0.5);
    expect(tl.gainAt(1500)).toBe(0.5);
  });
});

describe("B6 fadeIn / fadeOut 语法糖", () => {
  it("fadeIn(200) = 200ms 从 0 升到基础值", () => {
    const tl = evaluateVoice(
      voiceOf(gain(0.5, { envelope: fadeIn(200) })),
      2000,
      5000,
    );
    expect(tl.gainAt(1000)).toBe(0);
    expect(tl.gainAt(1100)).toBeCloseTo(0.25, 6);
    expect(tl.gainAt(1200)).toBe(0.5);
  });

  it("fadeOut(200) 贴声音实际终点倒算（源 500ms 播完处归零）", () => {
    const v = voiceOf(gain(1, { envelope: fadeOut(200) }));
    const tl = evaluateVoice(v, 500, 5000);
    expect(tl.endMs).toBe(1500);
    expect(tl.gainAt(1300)).toBe(1);
    expect(tl.gainAt(1400)).toBeCloseTo(0.5, 6);
    expect(tl.gainAt(1500)).toBe(0);
  });
});

describe("双端同源：预览自动化折点 = 导出取值折点", () => {
  it("gainPoints 在包络折点处等于 gainAt（预览据此排 AudioParam）", () => {
    const tl = evaluateVoice(
      voiceOf(gain(1, { envelope: curve([0, 0], [200, 1], [400, 0.2]) })),
      2000,
      5000,
    );
    for (const p of tl.gainPoints)
      expect(tl.gainAt(p.atMs)).toBeCloseTo(p.gain, 6);
    expect(tl.gainPoints.some((p) => p.atMs === 1200)).toBe(true);
  });
});

describe("构造期校验（写错在构造处暴露）", () => {
  it("curve 折点时间未严格递增 → spec_violation", () => {
    expect(() => curve([100, 1], [100, 0])).toThrow(/spec_violation/);
  });

  it("curve() 空折点 → spec_violation", () => {
    expect(() => curve()).toThrow(/spec_violation/);
  });

  it("ramp 负时长 / 负值 → spec_violation", () => {
    expect(() => ramp(0, 1, -1)).toThrow(/spec_violation/);
    expect(() => ramp(-0.1, 1, 100)).toThrow(/spec_violation/);
  });
});
