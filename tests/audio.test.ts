/**
 * 音频端到端：声音收集（登记期 env.audio / 运行期 ctx.audio → RunSummary.audioVoices）
 * 与离线混音（OfflineAudioMixer：多实例叠加 / loop 平铺 / 包络 / pan / 变速）。
 */
import { describe, expect, it } from "vitest";
import {
  TimelineEngine,
  clip,
  createScene,
  gain,
  loop,
  pan,
  rate,
  warp,
} from "@lingfan-video/core";
import { MemoryFrameSink, OfflineAudioMixer } from "@lingfan-video/infra";
import type { DecodedPcm } from "@lingfan-video/infra";
import type { AudioVoice, Ms, RenderError } from "@lingfan-video/contracts";

const FPS = 30;

function makeEngine() {
  const engine = new TimelineEngine({
    fps: FPS,
    width: 4,
    height: 4,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
  });
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(4 * 4 * 4),
    width: 4,
    height: 4,
  }));
  return engine;
}

/** 合成 PCM：指定声道数与毫秒时长的常量样本（确定性，测试可精确断言） */
function synthPcm(ms: number, channels = 2, value = 0.5): DecodedPcm {
  const rate = 48_000;
  const frames = Math.round((ms / 1000) * rate);
  return {
    clip: clip("synth"),
    sampleRate: rate,
    channels,
    durationMs: ms,
    data: new Float32Array(frames * channels).fill(value),
  };
}

function makeMixer(overrides?: Map<string, DecodedPcm>) {
  const library = overrides ?? new Map();
  const decoder = {
    async decode(c: { url: string }) {
      const pcm = library.get(c.url);
      if (!pcm) throw new Error(`test decoder: unknown clip ${c.url}`);
      return pcm;
    },
  };
  return new OfflineAudioMixer(decoder, { sampleRate: 48_000, channels: 2 });
}

/** 手工构造声音（离线混音测试用最小形态） */
function voice(
  startMs: Ms,
  extra?: Partial<Omit<AudioVoice, "id" | "startMs">>,
): AudioVoice {
  return {
    id: "v",
    clip: clip("x"),
    startMs,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    ...extra,
  };
}

describe("声音收集（登记期声明）", () => {
  it("audio 节点编译进 RunSummary.audioVoices，锚点换算全局绝对时间", async () => {
    const head = createScene(200, (_prev, env) => {
      env.audio(clip("sfx-a"), { at: 50, gain: gain(0.8) });
      env.step(200, () => {});
    });
    head.cutTo(100, (_prev, env) => {
      env.bgm(clip("loop-b")); // bgm = 循环到时间线尾的糖
    });
    const summary = await makeEngine().run(head, new MemoryFrameSink());
    expect(summary.audioVoices).toHaveLength(2);
    const [a, b] = summary.audioVoices;
    expect(a!.clip.url).toBe("sfx-a");
    expect(a!.startMs).toBe(50);
    expect(a!.gain.value).toBe(0.8);
    expect(a!.loop).toBeNull();
    expect(b!.clip.url).toBe("loop-b");
    expect(b!.startMs).toBe(200); // 第二段锚点 = 前段池长
    expect(b!.loop).toEqual({}); // bgm 缺省循环到终界
  });

  it("transition 短路后窗外音频不响（at ≥ spanEnd 不收集）", async () => {
    const next = createScene(200, () => {});
    const head = createScene(300, (_prev, env) => {
      env.audio(clip("late"), { at: 250 }); // 活跃窗只到 100ms（下一幕 transition 提前收窗）
      env.step(100, () => {});
      env.transitionTo(next);
    });
    const summary = await makeEngine().run(head, new MemoryFrameSink());
    expect(summary.audioVoices).toHaveLength(0);
  });
});

describe("声音收集（运行期 ctx.audio）", () => {
  it("step 回调内可发射声音，起点 = 当前求值时刻", async () => {
    const scene = createScene(300, (_prev, env) => {
      env.step(100, (ctx) => {
        if (ctx.frameIndex === 0) ctx.audio(clip("run-a"), { gain: gain(0.5) });
      });
      env.step(200, () => {});
    });
    const summary = await makeEngine().run(scene, new MemoryFrameSink());
    expect(summary.audioVoices).toHaveLength(1);
    expect(summary.audioVoices[0]!.clip.url).toBe("run-a");
    expect(summary.audioVoices[0]!.startMs).toBe(0);
  });

  it("最后一个 step 里触发的声音不会被丢（终界=时间线尾，仍是有效声音）", async () => {
    const scene = createScene(200, (_prev, env) => {
      env.step(200, (ctx) => {
        if (ctx.localT >= 100) ctx.audio(clip("last-frame"));
      });
    });
    const summary = await makeEngine().run(scene, new MemoryFrameSink());
    expect(summary.audioVoices.length).toBeGreaterThan(0);
    const last = summary.audioVoices[summary.audioVoices.length - 1]!;
    expect(last.clip.url).toBe("last-frame");
    expect(last.startMs).toBeLessThan(summary.durationMs);
  });

  it("句柄操作记录到 voice.ops（stop / setGain / setRate，时刻=求值时刻）", async () => {
    const scene = createScene(400, (_prev, env) => {
      env.step(400, (ctx) => {
        if (ctx.frameIndex === 0) {
          const h = ctx.audio(clip("h"), { gain: gain(0.5) });
          expect(h.startedAtMs).toBe(0);
          expect(h.alive).toBe(true);
        }
        if (ctx.localT === 100) pending = ctx.audio(clip("h2"));
        if (ctx.localT === 200) {
          pending?.setGain(1, 50);
          pending?.setRate(2, 0);
        }
        if (ctx.localT === 300) pending?.stop(100);
      });
    });
    let pending: import("@lingfan-video/contracts").AudioHandle | undefined;
    const summary = await makeEngine().run(scene, new MemoryFrameSink());
    const h = summary.audioVoices.find((v) => v.clip.url === "h2")!;
    expect(h.ops).toHaveLength(3);
    expect(h.ops[0]).toMatchObject({ kind: "gain", value: 1, rampMs: 50 });
    expect(h.ops[1]).toMatchObject({ kind: "rate", value: 2 });
    expect(h.ops[2]).toMatchObject({ kind: "stop", fadeMs: 100 });
  });

  it("回调之外操作句柄报 spec_violation（操作面只在 step/loop 窗口内有效）", async () => {
    let leaked: import("@lingfan-video/contracts").AudioHandle | undefined;
    const scene = createScene(100, (_prev, env) => {
      env.step(100, (ctx) => {
        if (!leaked) leaked = ctx.audio(clip("leak"));
      });
    });
    await makeEngine().run(scene, new MemoryFrameSink());
    let err: unknown;
    try {
      leaked!.stop();
    } catch (e) {
      err = e;
    }
    expect((err as RenderError).kind).toBe("spec_violation");
  });
});

describe("OfflineAudioMixer 混音", () => {
  it("单声音铺轨：位置、音量、声道复制（单声道源 → 双声道输出）", async () => {
    const mixer = makeMixer(new Map([["one", synthPcm(100, 1, 0.5)]]));
    const samples = await mixer.renderProgram({
      durationMs: 200,
      voices: [voice(50, { clip: clip("one") })],
    });
    const data = samples[0]!.data;
    const rate = 48_000;
    const ch = 2;
    const at = Math.round(0.05 * rate) * ch;
    expect(data[at - ch]!).toBe(0); // 起点前静音
    expect(data[at]!).toBeCloseTo(0.5, 5); // 单声道复制到双声道
    expect(data[at + 1]!).toBeCloseTo(0.5, 5);
    const end = Math.round(0.15 * rate) * ch; // 100ms 源 @50ms 起 → 150ms 结束
    expect(data[end]!).toBe(0);
  });

  it("多实例叠加：两声音重叠区样本相加", async () => {
    const mixer = makeMixer(
      new Map([
        ["x", synthPcm(100, 1, 0.25)],
        ["y", synthPcm(100, 1, 0.5)],
      ]),
    );
    const samples = await mixer.renderProgram({
      durationMs: 100,
      voices: [voice(0, { clip: clip("x") }), voice(0, { clip: clip("y") })],
    });
    expect(samples[0]!.data[0]!).toBeCloseTo(0.75, 5);
  });

  it("loop 平铺：100ms 源铺满 250ms 窗（回卷 1.5 圈）", async () => {
    const mixer = makeMixer(new Map([["lp", synthPcm(100, 1, 0.4)]]));
    const samples = await mixer.renderProgram({
      durationMs: 250,
      voices: [voice(0, { clip: clip("lp"), loop: loop() })],
    });
    const data = samples[0]!.data;
    const rate = 48_000;
    expect(data[Math.round(0.249 * rate * 2)]!).toBeCloseTo(0.4, 5);
    expect(data[Math.round(0.125 * rate * 2)]!).toBeCloseTo(0.4, 5);
  });

  it("fadeIn 包络：起点 0 → 淡入期线性上升", async () => {
    const mixer = makeMixer(new Map([["fd", synthPcm(200, 1, 1)]]));
    const samples = await mixer.renderProgram({
      durationMs: 200,
      voices: [voice(0, { clip: clip("fd"), gain: gain(1, { fadeIn: 100 }) })],
    });
    const data = samples[0]!.data;
    const rate = 48_000;
    expect(data[0]!).toBe(0);
    const mid = Math.round((50 / 1000) * rate) * 2;
    expect(data[mid]!).toBeCloseTo(0.5, 2);
    const after = Math.round(0.15 * rate) * 2;
    expect(data[after]!).toBeCloseTo(1, 2);
  });

  it("pan 摆位：pan=-1 全左（右声道 0）、pan=0.5 右声道衰减", async () => {
    const mixer = makeMixer(new Map([["pn", synthPcm(50, 1, 1)]]));
    const left = await mixer.renderProgram({
      durationMs: 50,
      voices: [voice(0, { clip: clip("pn"), pan: pan(-1) })],
    });
    expect(left[0]!.data[0]!).toBeCloseTo(1, 5);
    expect(left[0]!.data[1]!).toBe(0);
    const mid = await mixer.renderProgram({
      durationMs: 50,
      voices: [voice(0, { clip: clip("pn"), pan: pan(0.5) })],
    });
    expect(mid[0]!.data[0]!).toBeCloseTo(0.5, 5);
    expect(mid[0]!.data[1]!).toBeCloseTo(1, 5);
  });

  it("变速（rate(2)）：双倍速播完，时长减半", async () => {
    const mixer = makeMixer(new Map([["rs", synthPcm(100, 1, 1)]]));
    const samples = await mixer.renderProgram({
      durationMs: 200,
      voices: [voice(0, { clip: clip("rs"), rate: rate(2) })],
    });
    const data = samples[0]!.data;
    const rateHz = 48_000;
    // 100ms 源以 2 倍速 → 50ms 播完
    expect(data[Math.round(0.045 * rateHz) * 2]!).toBeCloseTo(1, 5);
    expect(data[Math.round(0.055 * rateHz) * 2]!).toBe(0);
  });

  it("warp 分段：先 2 倍速后恢复原速", async () => {
    const mixer = makeMixer(new Map([["wp", synthPcm(200, 1, 1)]]));
    const samples = await mixer.renderProgram({
      durationMs: 200,
      voices: [
        voice(0, {
          clip: clip("wp"),
          rate: warp([0, 0], [50, 100], [150, 200]), // 0-50ms 2 倍，之后 1 倍
        }),
      ],
    });
    const data = samples[0]!.data;
    const rateHz = 48_000;
    expect(data[Math.round(0.049 * rateHz) * 2]!).toBeCloseTo(1, 5);
    expect(data[Math.round(0.051 * rateHz) * 2]!).toBeCloseTo(1, 5);
    // 50ms 处已播到源 100ms；再 100ms 播完余下 100ms → 150ms 结束
    expect(data[Math.round(0.149 * rateHz) * 2]!).toBeCloseTo(1, 5);
    expect(data[Math.round(0.151 * rateHz) * 2]!).toBe(0);
  });
});
