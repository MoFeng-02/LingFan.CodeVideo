/**
 * 程序化音源（synth）与总线延迟/混响。
 * 覆盖：确定性合成、ADSR、登记期/运行期发射、离线混音、延迟回声、混响尾音、非法 spec。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, clip, start } from "@lingfan-video/core";
import { OfflineAudioMixer } from "@lingfan-video/infra";
import { renderSynth } from "../packages/infra/src/audio/synth";
import { mixBusGraph } from "../packages/infra/src/audio/bus-mixer";
import type {
  AudioGraph,
  AudioProgram,
  AudioVoice,
} from "@lingfan-video/contracts";

function makeEngine() {
  const engine = new TimelineEngine({
    fps: 30,
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

function synthVoice(
  startMs: number,
  spec: AudioVoice["synth"],
  extra?: Partial<AudioVoice>,
): AudioVoice {
  return {
    id: `v@${startMs}`,
    clip: clip("synth:test"),
    startMs,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    synth: spec,
    ...extra,
  };
}

function energy(data: Float32Array, fromMs: number, toMs: number): number {
  const sr = 48_000;
  const from = Math.max(0, Math.round((fromMs / 1000) * sr));
  const to = Math.min(
    Math.floor(data.length / 2),
    Math.round((toMs / 1000) * sr),
  );
  let sum = 0;
  for (let i = from; i < to; i++) sum += Math.abs(data[i * 2]!);
  return sum;
}

describe("程序化音源", () => {
  it("合成确定性：同一 spec 两次渲染逐样本相同", () => {
    const spec = {
      wave: "sine" as const,
      freq: 440,
      durationMs: 200,
      gain: 0.5,
    };
    const a = renderSynth(spec, 48_000, 2);
    const b = renderSynth(spec, 48_000, 2);
    expect(a.data.length).toBe(b.data.length);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(a.data.length).toBe(48_000 * 2 * 0.2);
  });

  it("噪声种子：同 seed 逐样本相同，换 seed 换一条噪声", () => {
    const spec = {
      wave: "noise" as const,
      freq: 440,
      durationMs: 100,
      seed: 777,
    };
    const a = renderSynth(spec, 48_000, 1);
    const b = renderSynth(spec, 48_000, 1);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    const other = renderSynth({ ...spec, seed: 778 }, 48_000, 1);
    expect(Array.from(other.data)).not.toEqual(Array.from(a.data));
  });

  it("非噪声波形忽略种子：换 seed 不改变样本", () => {
    const base = { wave: "sine" as const, freq: 440, durationMs: 50 };
    const a = renderSynth({ ...base, seed: 1 }, 48_000, 1);
    const b = renderSynth({ ...base, seed: 2 }, 48_000, 1);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("登记期声明的声音带 seed 与音量：离线混音与合成样本逐样本一致", async () => {
    const engine = makeEngine();
    const spec = {
      wave: "noise" as const,
      freq: 440,
      durationMs: 200,
      gain: 0.8,
      seed: 4242,
      // 常幅包络：混音结果与合成样本之间只剩音量这一层关系
      envelope: { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 },
    };
    const scene = start(200, (env) => {
      env.synth(spec);
      env.step(200, () => {});
    });
    const summary = await engine.run(scene, {
      writeFrame: () => {},
      finalize: async () => {},
    });
    const v = summary.audioVoices[0]!;
    expect(v.synth?.seed).toBe(4242);
    // 时间线侧的增益保持中性：声音的音量已经写在声音自己的参数里
    expect(v.gain.value).toBe(1);
    const mixer = new OfflineAudioMixer(
      {
        async decode() {
          throw new Error("synth 不应走素材解码");
        },
      },
      { sampleRate: 48_000, channels: 2 },
    );
    const [sample] = await mixer.renderProgram({
      durationMs: 200,
      voices: [v],
    });
    const expected = renderSynth(spec, 48_000, 2);
    // 声明的音量在合成时乘一次，混音不再叠乘：两者逐样本相等
    for (const i of [1000, 5000]) {
      expect(Math.abs(expected.data[i]!)).toBeGreaterThan(1e-3);
      expect(sample!.data[i]!).toBeCloseTo(expected.data[i]!, 6);
    }
  });

  it("ADSR 起音有斜坡、中段达峰、尾段释放归零", () => {
    const spec = {
      wave: "sine" as const,
      freq: 440,
      durationMs: 400,
      gain: 1,
      envelope: { attackMs: 100, decayMs: 0, sustain: 1, releaseMs: 100 },
    };
    const pcm = renderSynth(spec, 48_000, 1);
    expect(Math.abs(pcm.data[0]!)).toBeLessThan(0.02);
    const from = Math.floor(0.15 * 48_000);
    const to = Math.floor(0.25 * 48_000);
    let peak = 0;
    for (let i = from; i < to; i++)
      peak = Math.max(peak, Math.abs(pcm.data[i]!));
    expect(peak).toBeGreaterThan(0.9);
    expect(Math.abs(pcm.data[pcm.data.length - 1]!)).toBeLessThan(0.02);
  });

  it("登记期 env.synth 与运行期 ctx.synth 都产出声音（带 synth 字段）", async () => {
    const engine = makeEngine();
    const scene = start(200, (env) => {
      env.synth({ wave: "sine", freq: 440, durationMs: 200 });
      env.step(200, (ctx) => {
        if (ctx.frameIndex === 0)
          ctx.synth({ wave: "square", freq: 220, durationMs: 100 });
      });
    });
    const summary = await engine.run(scene, {
      writeFrame: () => {},
      finalize: async () => {},
    });
    expect(summary.audioVoices).toHaveLength(2);
    const [a, b] = summary.audioVoices;
    expect(a!.synth?.wave).toBe("sine");
    expect(a!.startMs).toBe(0);
    // 音量属于声音本身（`synth.gain`），声音的时间线增益保持中性，避免乘两次
    expect(a!.gain.value).toBe(1);
    expect(b!.synth?.wave).toBe("square");
    expect(b!.startMs).toBe(0);
  });

  it("离线混音：synth 声音不经解码器也能出声", async () => {
    const mixer = new OfflineAudioMixer(
      {
        async decode() {
          throw new Error("synth 不应走素材解码");
        },
      },
      { sampleRate: 48_000, channels: 2 },
    );
    const program: AudioProgram = {
      durationMs: 300,
      voices: [
        synthVoice(0, {
          wave: "sine",
          freq: 440,
          durationMs: 300,
          gain: 0.5,
        }),
      ],
    };
    const [sample] = await mixer.renderProgram(program);
    expect(energy(sample!.data, 50, 250)).toBeGreaterThan(10);
  });

  it("总线延迟效果：干声被替换为延迟声（前 100ms 静音、之后有声）", async () => {
    const graph: AudioGraph = {
      buses: [
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs: 100, feedback: 0, mix: 1 }],
        },
      ],
      sends: [],
      ducks: [],
      automation: [],
    };
    const out = mixBusGraph({
      sampleRate: 48_000,
      channels: 2,
      frames: 48_000,
      durationMs: 1000,
      voices: [
        synthVoice(
          0,
          {
            wave: "sine",
            freq: 440,
            durationMs: 400,
            gain: 0.5,
          },
          { bus: "fx" },
        ),
      ],
      graph,
      layoutVoice: (voice, target, outFrames, durationMs) => {
        // 直接用简单的全幅铺法代替 mixer 的 layoutVoice（delay 只关心时序）
        const pcm = renderSynth(voice.synth!, 48_000, 2);
        const offset = Math.round((voice.startMs / 1000) * 48_000) * 2;
        for (let i = 0; i + offset < target.length && i < pcm.data.length; i++)
          target[i + offset]! += pcm.data[i]!;
        void outFrames;
        void durationMs;
      },
    });
    expect(energy(out, 0, 90)).toBeLessThan(0.01);
    expect(energy(out, 110, 300)).toBeGreaterThan(1);
  });

  it("总线混响效果：输入结束后仍有尾音", async () => {
    const graph: AudioGraph = {
      buses: [{ id: "verb", effects: [{ kind: "reverb", mix: 0.8 }] }],
      sends: [],
      ducks: [],
      automation: [],
    };
    const out = mixBusGraph({
      sampleRate: 48_000,
      channels: 2,
      frames: 48_000,
      durationMs: 1000,
      voices: [
        synthVoice(
          0,
          {
            wave: "sine",
            freq: 440,
            durationMs: 100,
            gain: 0.5,
          },
          { bus: "verb" },
        ),
      ],
      graph,
      layoutVoice: (voice, target) => {
        const pcm = renderSynth(voice.synth!, 48_000, 2);
        for (let i = 0; i < pcm.data.length && i < target.length; i++)
          target[i]! += pcm.data[i]!;
      },
    });
    expect(energy(out, 400, 900)).toBeGreaterThan(0.5);
  });

  it("非法 spec：durationMs ≤ 0 在渲染期报 spec_violation", async () => {
    const engine = makeEngine();
    const scene = start(100, (env) => {
      env.synth({ wave: "sine", freq: 440, durationMs: 0 });
      env.step(100, () => {});
    });
    await expect(
      engine.run(scene, { writeFrame: () => {}, finalize: async () => {} }),
    ).rejects.toThrow(/spec_violation|durationMs/);
  });
});
