/**
 * 音频图（B4-1）：总线路由与增益 / 发送叠加 / 逐帧自动化插值 /
 * 侧链 duck / 总线 kill(fadeOut) / 成环报错 / 运行期懒建总线。
 * 端到端：TimelineEngine 收集 RunSummary.audioGraph + audioVoices →
 * OfflineAudioMixer.renderProgram 出交错 Float32，直接断言样本值。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, clip, createScene } from "@lingfan-video/core";
import type { RunSummary } from "@lingfan-video/core";
import { MemoryFrameSink, OfflineAudioMixer } from "@lingfan-video/infra";
import type { DecodedPcm } from "@lingfan-video/infra";
import type { Scene } from "@lingfan-video/contracts";

const SR = 48_000;

function makeEngine(fps = 30) {
  const engine = new TimelineEngine({
    fps,
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

/** 常量 PCM（确定性，可精确断言样本值） */
function synthPcm(url: string, ms: number, value = 0.5): DecodedPcm {
  const frames = Math.round((ms / 1000) * SR);
  return {
    clip: clip(url),
    sampleRate: SR,
    channels: 2,
    durationMs: ms,
    data: new Float32Array(frames * 2).fill(value),
  };
}

function makeMixer() {
  const library = new Map<string, DecodedPcm>([
    ["pad", synthPcm("pad", 1000)],
    ["sfx", synthPcm("sfx", 100)],
  ]);
  return new OfflineAudioMixer(
    {
      async decode(c: { url: string }) {
        const pcm = library.get(c.url);
        if (!pcm) throw new Error(`test decoder: unknown clip ${c.url}`);
        return pcm;
      },
    },
    { sampleRate: SR, channels: 2 },
  );
}

async function run(scene: Scene, fps = 30): Promise<RunSummary> {
  return makeEngine(fps).run(scene, new MemoryFrameSink());
}

async function render(
  summary: RunSummary,
  overrides?: Map<string, DecodedPcm>,
): Promise<Float32Array> {
  const mixer = makeMixer();
  void overrides;
  const [sample] = await mixer.renderProgram({
    durationMs: summary.durationMs,
    voices: summary.audioVoices,
    graph: summary.audioGraph,
  });
  return sample!.data;
}

/** 取某个时间点的左声道样本 */
function at(data: Float32Array, ms: number): number {
  return data[Math.round((ms / 1000) * SR) * 2]!;
}

describe("音频图：路由与增益", () => {
  it("声音进总线后按总线增益缩放", async () => {
    const scene = createScene(1000, (_prev, env) => {
      env.bus({ id: "music", gain: 0.5 });
      env.audio(clip("pad"), { bus: "music" });
      env.step(1000, () => {});
    });
    const summary = await run(scene);
    const data = await render(summary);
    expect(at(data, 100)).toBeCloseTo(0.5 * 0.5, 3);
  });

  it("send 把总线输出叠加到目标总线（post-fader）", async () => {
    const scene = createScene(1000, (_prev, env) => {
      env.bus({ id: "music", gain: 0.5 });
      env.bus({ id: "verb" });
      env.send({ from: "music", to: "verb", amount: 0.5 });
      env.audio(clip("pad"), { bus: "music" });
      env.step(1000, () => {});
    });
    const summary = await run(scene);
    const data = await render(summary);
    // master = music(0.5*0.5) + verb(music*0.5)
    expect(at(data, 100)).toBeCloseTo(0.25 + 0.125, 3);
  });

  it("运行期懒建总线：ctx.bus 后运行期声音按总线增益", async () => {
    const scene = createScene(1000, (_prev, env) => {
      env.step(1000, (ctx) => {
        if (ctx.frameIndex !== 0) return;
        ctx.bus("fx", { gain: 0.5 });
        ctx.audio(clip("pad"), { bus: "fx" });
      });
    });
    const summary = await run(scene);
    const data = await render(summary);
    expect(at(data, 100)).toBeCloseTo(0.25, 3);
  });
});

describe("音频图：逐帧自动化", () => {
  it("逐帧参数：相邻帧之间线性插值，之后保持", async () => {
    const scene = createScene(1000, (_prev, env) => {
      env.bus({ id: "music" });
      env.audio(clip("pad"), { bus: "music" });
      env.step(1000, (ctx) => {
        if (ctx.t === 0) ctx.bus("music").gain(0.2);
        if (ctx.t === 100) ctx.bus("music").gain(0.8);
      });
    });
    const summary = await run(scene, 10);
    const data = await render(summary);
    // 0ms(0.2) → 100ms(0.8)：50ms 处 ≈ 0.5，之后保持 0.8
    expect(at(data, 50)).toBeCloseTo(0.5 * 0.5, 2);
    expect(at(data, 700)).toBeCloseTo(0.5 * 0.8, 2);
  });
});

describe("音频图：侧链 duck", () => {
  it("触发总线发声时压低目标总线，释放后恢复", async () => {
    const scene = createScene(1000, (_prev, env) => {
      env.bus({ id: "music", gain: 1 });
      env.bus({ id: "sfx" });
      env.duck({
        from: "sfx",
        to: "music",
        amountDb: 12,
        thresholdDb: -30,
        attackMs: 1,
        holdMs: 20,
        releaseMs: 20,
      });
      env.audio(clip("pad"), { bus: "music" }); // 全程底音
      env.step(1000, (ctx) => {
        if (ctx.t !== 400) return;
        ctx.audio(clip("sfx"), { bus: "sfx" }); // 400..500ms 的触发声
      });
    });
    const summary = await run(scene, 20);
    const data = await render(summary);
    expect(at(data, 200)).toBeCloseTo(0.5, 2); // 未触发
    // 450ms：底音被压低（另有触发声本身 0.5，故总电平看 550ms 释放尾巴）
    expect(at(data, 450)).toBeLessThan(0.7);
    expect(at(data, 550)).toBeLessThan(0.2);
    expect(at(data, 900)).toBeGreaterThan(0.45); // 释放后恢复
  });
});

describe("音频图：生命周期", () => {
  it("总线 kill(fadeOut) 窗口内衰减，窗口结束静音", async () => {
    const scene = createScene(1000, (_prev, env) => {
      env.audio(clip("pad"), { bus: "music" });
      env.step(1000, (ctx) => {
        if (ctx.t === 0) ctx.bus("music", { gain: 1 });
        if (ctx.t === 300) ctx.bus("music").kill({ fadeOut: 200 });
      });
    });
    const summary = await run(scene);
    const data = await render(summary);
    expect(at(data, 200)).toBeCloseTo(0.5, 2);
    expect(at(data, 400)).toBeGreaterThan(0.05);
    expect(at(data, 400)).toBeLessThan(0.4);
    expect(at(data, 700)).toBe(0);
  });

  it("父链成环：spec_violation", async () => {
    const scene = createScene(1000, (_prev, env) => {
      env.bus({ id: "a", parent: "b" });
      env.bus({ id: "b", parent: "a" });
      env.audio(clip("pad"), { bus: "a" });
      env.step(1000, () => {});
    });
    await expect(run(scene)).rejects.toThrow(/成环|spec_violation/);
  });
});
