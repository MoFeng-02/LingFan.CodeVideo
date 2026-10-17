/**
 * 音频时间映射（warp / 变速）：解析、求值、逆映射、速率分段，
 * 以及离线混音端的变速铺轨（2 倍速 / 恢复原速 / 斜率延续 / 源尾填满 / 变速 loop）。
 * 变速 = 磁带式重采样：源位置只由映射表推导，导出与预览共用同一实现。
 */
import { describe, expect, it } from "vitest";
import {
  TimelineEngine,
  createScene,
  validateScene,
} from "@lingfan-video/core";
import {
  MemoryFrameSink,
  OfflineAudioMixer,
  rateSegments,
  resolveWarp,
  sourceMsAt,
  timelineMsAtSource,
} from "@lingfan-video/infra";
import type { DecodedPcm } from "@lingfan-video/infra";

const OUT_RATE = 48_000;

/** 合成 PCM：值为帧号（递增斜坡），便于逐样本断言源位置 */
function rampPcm(ms: number, channels = 1): DecodedPcm {
  const frames = Math.round((ms / 1000) * OUT_RATE);
  const data = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++)
    for (let ch = 0; ch < channels; ch++) data[f * channels + ch] = f;
  return {
    clip: { url: "ramp", kind: "audio" },
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

/** 输出缓冲第 frame 帧的左声道（交错布局） */
function left(data: Float32Array, frame: number, channels = 2): number {
  return data[frame * channels]!;
}

describe("warp 解析与求值", () => {
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
    expect(sourceMsAt(w, 600)).toBe(1200); // 末锚点之后仍 2 倍速
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
    expect(sourceMsAt(w, 750)).toBe(1250); // 500..1000 段为原速
    expect(sourceMsAt(w, 1500)).toBe(2000); // 末段原速延续
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
    expect(sourceMsAt(w, 400)).toBe(1000); // 事件尾 = 源尾
    expect(timelineMsAtSource(w, 1000)).toBe(400);
    expect(rateSegments(w)).toEqual([{ fromMs: 0, rate: 2.5 }]);
  });

  it("首锚点晚于 0：其前由隐式原点线性插值（不是跳变，斜率一致）", () => {
    const w = resolveWarp([{ atMs: 200, srcMs: 400 }], 4000);
    expect(w.points[0]).toEqual({ atMs: 0, srcMs: 0 });
    expect(sourceMsAt(w, 100)).toBe(200); // (0,0)→(200,400)：全段速率 2
    expect(sourceMsAt(w, 400)).toBe(800); // 末锚点后斜率延续
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

  it("非法锚点：时间不递增 / 源不递增 / end 非末位 / 空数组", () => {
    const end = (warp: Parameters<typeof resolveWarp>[0]): string => {
      try {
        resolveWarp(warp, 1000);
        return "no-throw";
      } catch (e) {
        return (e as Error).name;
      }
    };
    expect(
      end([
        { atMs: 100, srcMs: 0 },
        { atMs: 100, srcMs: 50 },
      ]),
    ).toBe("SpecViolation");
    expect(
      end([
        { atMs: 0, srcMs: 100 },
        { atMs: 100, srcMs: 100 },
      ]),
    ).toBe("SpecViolation"); // 速率 0（时间停滞）
    expect(
      end([
        { atMs: 0, srcMs: 0 },
        { atMs: 50, srcMs: "end" },
        { atMs: 100, srcMs: 200 },
      ]),
    ).toBe("SpecViolation");
    expect(end([])).toBe("no-throw"); // 空数组按「无 warp」处理（校验期已报错的兜底）
  });
});

describe("离线混音端变速铺轨", () => {
  it("2 倍速：输出帧 i 取源位置 2i（磁带式重采样）", async () => {
    const mixer = makeMixer(rampPcm(100));
    const [sample] = await mixer.renderTimeline(200, [
      {
        clipUrl: "ramp",
        globalAtMs: 0,
        volume: 1,
        loop: false,
        pan: 0,
        warp: [
          { atMs: 0, srcMs: 0 },
          { atMs: 25, srcMs: 50 },
        ],
      },
    ]);
    const data = sample!.data;
    expect(left(data, 0)).toBe(0);
    expect(left(data, 1200)).toBeCloseTo(2400, 0); // 25ms 处 → 源 50ms
    expect(left(data, 2399)).toBeCloseTo(4798, 0); // 末帧 → 源 4798
    // 源 100ms 播完即静音（2 倍速下 50ms 收尾）
    expect(left(data, 2400)).toBe(0);
    expect(left(data, 4800)).toBe(0);
  });

  it('srcMs:"end" 填满事件区间：事件尾正好落在源尾，其后静音', async () => {
    const mixer = makeMixer(rampPcm(1000));
    const [sample] = await mixer.renderTimeline(600, [
      {
        clipUrl: "ramp",
        globalAtMs: 0,
        volume: 1,
        loop: false,
        pan: 0,
        warp: [
          { atMs: 0, srcMs: 0 },
          { atMs: 400, srcMs: "end" },
        ],
      },
    ]);
    const data = sample!.data;
    // 速率 2.5：400ms = 19200 帧时源位置 48000（正好越界，静音）
    expect(left(data, 19_199)).toBeGreaterThan(47_000);
    expect(left(data, 19_200)).toBe(0);
    expect(left(data, 28_799)).toBe(0); // 600ms 窗尾仍静音
  });

  it("变速 loop：在源空间回卷（零点周期随时间线速率变化）", async () => {
    const mixer = makeMixer(rampPcm(100));
    const [sample] = await mixer.renderTimeline(200, [
      {
        clipUrl: "ramp",
        globalAtMs: 0,
        volume: 1,
        loop: true,
        pan: 0,
        warp: [
          { atMs: 0, srcMs: 0 },
          { atMs: 50, srcMs: 100 },
        ],
      },
    ]);
    const data = sample!.data;
    // 源 100ms 按 2 倍速播完用 50ms，随后回卷：50ms 处回到源 0
    expect(left(data, 25 * 48)).toBeGreaterThan(2000); // 25ms → 源 50ms
    expect(left(data, 50 * 48)).toBeCloseTo(0, 0); // 回卷点
    expect(left(data, 75 * 48)).toBeGreaterThan(2000); // 第二圈 25ms → 源 50ms
  });
});

describe("warp 与引擎/校验的衔接", () => {
  it("audio 选项的 warp 透传进时间线事件（原样保留，不预解析）", async () => {
    const warp = [
      { atMs: 0, srcMs: 0 },
      { atMs: 100, srcMs: 200 },
    ] as const;
    const head = createScene(200, (_prev, env) => {
      env.audio({ url: "sfx" }, { at: 50, warp: [...warp] });
      env.step(200, () => {});
    });
    const engine = new TimelineEngine({
      fps: 30,
      width: 4,
      height: 4,
      canvas: null,
      headless: true,
    });
    engine.setPainter(() => ({
      data: new Uint8ClampedArray(4 * 4 * 4),
      width: 4,
      height: 4,
    }));
    const summary = await engine.run(head, new MemoryFrameSink());
    expect(summary.audioEvents[0]!.warp).toEqual(warp);
    expect(summary.audioEvents[0]!.globalAtMs).toBe(50);
  });

  it("校验期拦下非法 warp（时间不递增 / 源不递增 / end 非末位）", () => {
    const scene = createScene(200, (_prev, env) => {
      env.audio(
        { url: "bad" },
        {
          warp: [
            { atMs: 100, srcMs: 0 },
            { atMs: 100, srcMs: 50 },
          ],
        },
      );
      env.audio(
        { url: "bad2" },
        {
          warp: [
            { atMs: 0, srcMs: 100 },
            { atMs: 100, srcMs: 50 },
          ],
        },
      );
      env.audio(
        { url: "bad3" },
        {
          warp: [
            { atMs: 0, srcMs: 0 },
            { atMs: 50, srcMs: "end" },
            { atMs: 100, srcMs: 200 },
          ],
        },
      );
      env.audio({ url: "bad4" }, { warp: [] });
      env.step(200, () => {});
    });
    const errors = validateScene(scene);
    expect(errors.filter((e) => e.code === "spec_violation")).toHaveLength(4);
  });
});
