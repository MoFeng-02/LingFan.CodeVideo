/**
 * 音频时间映射（warp / 变速）：解析、求值、逆映射、速率分段，
 * 以及离线混音端的变速铺轨（2 倍速 / 恢复原速 / 斜率延续 / 源尾填满 / 变速 loop / 运行期 setRate）。
 * 变速 = 磁带式重采样：源位置只由映射表推导，导出与预览共用同一实现（evaluateVoice）。
 */
import { describe, expect, it } from "vitest";
import {
  TimelineEngine,
  clip,
  createScene,
  gain as gainOf,
  rate as rateOf,
  validateScene,
  warp as warpOf,
} from "@lingfan-video/core";
import {
  MemoryFrameSink,
  OfflineAudioMixer,
  evaluateVoice,
  rateSegments,
  resolveWarp,
  sourceMsAt,
  timelineMsAtSource,
} from "@lingfan-video/infra";
import type { DecodedPcm } from "@lingfan-video/infra";
import type { AudioRate, AudioVoice, Ms } from "@lingfan-video/contracts";

const OUT_RATE = 48_000;

/** 合成 PCM：值为帧号（递增斜坡），便于逐样本断言源位置 */
function rampPcm(ms: number, channels = 1): DecodedPcm {
  const frames = Math.round((ms / 1000) * OUT_RATE);
  const data = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++)
    for (let ch = 0; ch < channels; ch++) data[f * channels + ch] = f;
  return {
    clip: clip("ramp"),
    sampleRate: OUT_RATE,
    channels,
    durationMs: ms,
    data,
  };
}

function makeMixer(pcm: DecodedPcm) {
  const decoder = {
    async decode() {
      return pcm;
    },
  };
  return new OfflineAudioMixer(decoder, {
    sampleRate: OUT_RATE,
    channels: 2,
  });
}

function voice(startMs: Ms, extra?: Partial<AudioVoice>): AudioVoice {
  return {
    id: "v",
    clip: clip("ramp"),
    startMs,
    gain: gainOf(1),
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    ...extra,
  };
}

/** 输出缓冲第 frame 帧的左声道（交错布局） */
function left(data: Float32Array, frame: number, channels = 2): number {
  return data[frame * channels]!;
}

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

describe("warp 与引擎/校验的衔接", () => {
  const engine = () => {
    const e = new TimelineEngine({
      fps: 30,
      width: 4,
      height: 4,
      canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
      headless: true,
    });
    e.setPainter(() => ({
      data: new Uint8ClampedArray(4 * 4 * 4),
      width: 4,
      height: 4,
    }));
    return e;
  };

  it("audio 选项的 rate 透传进声音记录（原样保留，不预解析）", async () => {
    const head = createScene(200, (_prev, env) => {
      env.audio(clip("sfx"), { at: 50, rate: warpOf([0, 0], [100, 200]) });
      env.step(200, () => {});
    });
    const summary = await engine().run(head, new MemoryFrameSink());
    const v = summary.audioVoices[0]!;
    expect(v.rate).toEqual({
      kind: "warp",
      points: [
        { atMs: 0, srcMs: 0 },
        { atMs: 100, srcMs: 200 },
      ],
    });
    expect(v.startMs).toBe(50);
  });

  it("校验期兜底拦截字面量非法选项（组合子之外的结构对象）", () => {
    const badRate = (points: readonly unknown[]): AudioRate =>
      ({ kind: "warp", points }) as AudioRate;
    const scene = createScene(200, (_prev, env) => {
      env.audio(clip("bad"), {
        rate: badRate([
          { atMs: 100, srcMs: 0 },
          { atMs: 100, srcMs: 50 },
        ]),
      });
      env.audio(clip("bad2"), {
        rate: badRate([
          { atMs: 0, srcMs: 100 },
          { atMs: 100, srcMs: 50 },
        ]),
      });
      env.audio(clip("bad3"), { pan: { value: 3 } });
      env.audio(clip("bad4"), { gain: { value: -1 } });
      env.step(200, () => {});
    });
    const errors = validateScene(scene);
    expect(errors.filter((e) => e.code === "spec_violation")).toHaveLength(4);
  });
});
