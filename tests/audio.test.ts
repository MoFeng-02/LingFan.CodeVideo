/**
 * 音频端到端：事件收集（编译期 audio 节点 → RunSummary.audioEvents）
 * 与离线混音（OfflineAudioMixer：多实例叠加 / loop 平铺 / fade 包络 / pan 摆位）。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, createScene } from "@lingfan-video/core";
import { MemoryFrameSink, OfflineAudioMixer } from "@lingfan-video/infra";
import type { DecodedPcm } from "@lingfan-video/infra";

const FPS = 30;

function makeEngine() {
  const engine = new TimelineEngine({
    fps: FPS,
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
  return engine;
}

/** 合成 PCM：指定声道数与毫秒时长的正弦/直流样本（确定性，测试可精确断言） */
function synthPcm(ms: number, channels = 2, value = 0.5): DecodedPcm {
  const rate = 48_000;
  const frames = Math.round((ms / 1000) * rate);
  return {
    clip: { url: "synth", kind: "audio" },
    sampleRate: rate,
    channels,
    durationMs: ms,
    data: new Float32Array(frames * channels).fill(value),
  };
}

function makeMixer(overrides?: Map<string, DecodedPcm>) {
  const library = overrides ?? new Map();
  const decoder = {
    async decode(clip: { url: string }) {
      const pcm = library.get(clip.url);
      if (!pcm) throw new Error(`test decoder: unknown clip ${clip.url}`);
      return pcm;
    },
  };
  return new OfflineAudioMixer(decoder, { sampleRate: 48_000, channels: 2 });
}

describe("audio 事件收集", () => {
  it("audio 节点编译进 RunSummary.audioEvents，锚点换算全局绝对时间", async () => {
    const head = createScene(200, (_prev, env) => {
      env.audio({ url: "sfx-a" }, { at: 50, volume: 0.8 });
      env.step(200, () => {});
    });
    const scene = head.cutTo(100, (_prev, env) => {
      env.bgm({ url: "loop-b" }); // bgm = loop:true 糖
    });
    // cutTo 返回链尾：时间线必须从 head 起
    void scene;
    const summary = await makeEngine().run(head, new MemoryFrameSink());
    expect(summary.audioEvents).toHaveLength(2);
    const [a, b] = summary.audioEvents;
    expect(a.clipUrl).toBe("sfx-a");
    expect(a.globalAtMs).toBe(50);
    expect(a.volume).toBe(0.8);
    expect(a.loop).toBe(false);
    expect(b.clipUrl).toBe("loop-b");
    expect(b.globalAtMs).toBe(200); // 第二段锚点 = 前段池长
    expect(b.loop).toBe(true);
  });

  it("transition 短路后窗外 audio 不响（at ≥ spanEnd 不收集）", async () => {
    const next = createScene(200, () => {});
    const head = createScene(300, (_prev, env) => {
      env.audio({ url: "late" }, { at: 250 }); // 活跃窗只到 100ms（下一幕 transition 提前收窗）
      env.step(100, () => {});
      env.transitionTo(next);
    });
    const summary = await makeEngine().run(head, new MemoryFrameSink());
    expect(summary.audioEvents).toHaveLength(0);
  });
});

describe("OfflineAudioMixer 混音", () => {
  it("单事件铺轨：位置、音量、声道复制（单声道源 → 双声道输出）", async () => {
    const pcm = synthPcm(100, 1, 0.5); // 单声道源
    const mixer = makeMixer(new Map([["one", pcm]]));
    const samples = await mixer.renderTimeline(200, FPS, [
      {
        clipUrl: "one",
        globalAtMs: 50,
        volume: 1,
        loop: false,
        pan: 0,
      },
    ]);
    const data = samples[0]!.data;
    const rate = 48_000;
    const ch = 2;
    const at = Math.round(0.05 * rate) * ch;
    // 事件起点前静音
    expect(data[at - ch]!).toBe(0);
    // 源内：双声道复制单声道源（左右同值 0.5）
    expect(data[at]!).toBeCloseTo(0.5, 5);
    expect(data[at + 1]!).toBeCloseTo(0.5, 5);
    // 源尾之后静音（100ms 源 @50ms 起 → 150ms 处结束）
    const end = Math.round(0.15 * rate) * ch;
    expect(data[end]!).toBe(0);
  });

  it("多实例叠加：两事件重叠区样本相加", async () => {
    const mixer = makeMixer(
      new Map([
        ["x", synthPcm(100, 1, 0.25)],
        ["y", synthPcm(100, 1, 0.5)],
      ]),
    );
    const samples = await mixer.renderTimeline(100, FPS, [
      { clipUrl: "x", globalAtMs: 0, volume: 1, loop: false, pan: 0 },
      { clipUrl: "y", globalAtMs: 0, volume: 1, loop: false, pan: 0 },
    ]);
    const data = samples[0]!.data;
    expect(data[0]!).toBeCloseTo(0.75, 5); // 0.25 + 0.5
  });

  it("loop 平铺：100ms 源铺满 250ms 窗（回卷 1.5 圈）", async () => {
    const mixer = makeMixer(new Map([["lp", synthPcm(100, 1, 0.4)]]));
    const samples = await mixer.renderTimeline(250, FPS, [
      { clipUrl: "lp", globalAtMs: 0, volume: 1, loop: true, pan: 0 },
    ]);
    const data = samples[0]!.data;
    const rate = 48_000;
    // 全程非零（回卷平铺到窗尾）
    expect(data[Math.round(0.249 * rate * 2)]!).toBeCloseTo(0.4, 5);
    expect(data[Math.round(0.125 * rate * 2)]!).toBeCloseTo(0.4, 5);
  });

  it("fadeIn 包络：起点 0 → 淡入期线性上升", async () => {
    const mixer = makeMixer(new Map([["fd", synthPcm(200, 1, 1)]]));
    const fadeInMs = 100;
    const samples = await mixer.renderTimeline(200, FPS, [
      {
        clipUrl: "fd",
        globalAtMs: 0,
        volume: 1,
        fadeIn: fadeInMs,
        loop: false,
        pan: 0,
      },
    ]);
    const data = samples[0]!.data;
    const rate = 48_000;
    expect(data[0]!).toBe(0); // 起点静音
    const mid = Math.round((fadeInMs / 2 / 1000) * rate) * 2;
    expect(data[mid]!).toBeCloseTo(0.5, 2); // 淡入中点 ≈ 半增益
    const after = Math.round(0.15 * rate) * 2;
    expect(data[after]!).toBeCloseTo(1, 2); // 淡入结束后全增益
  });

  it("pan 摆位：pan=-1 全左（右声道 0）、pan=0.5 右声道衰减", async () => {
    const mixer = makeMixer(new Map([["pn", synthPcm(50, 1, 1)]]));
    const left = await mixer.renderTimeline(50, FPS, [
      { clipUrl: "pn", globalAtMs: 0, volume: 1, loop: false, pan: -1 },
    ]);
    expect(left[0]!.data[0]!).toBeCloseTo(1, 5);
    expect(left[0]!.data[1]!).toBe(0);
    const mid = await mixer.renderTimeline(50, FPS, [
      { clipUrl: "pn", globalAtMs: 0, volume: 1, loop: false, pan: 0.5 },
    ]);
    expect(mid[0]!.data[0]!).toBeCloseTo(0.5, 5); // 1 - 0.5
    expect(mid[0]!.data[1]!).toBeCloseTo(1, 5);
  });
});
