/**
 * 双端同源：预览端把声音交给音频线程，导出端整段离线渲染——
 * 两条路径跑同一个混音内核，因此对同一程序必须逐样本一致。
 */
import { describe, expect, it } from "vitest";
import type {
  AudioGraph,
  AudioProgram,
  AudioVoice,
} from "@lingfan-video/contracts";
import { OfflineAudioMixer } from "@lingfan-video/infra";
import { previewSamples } from "./support/worklet-harness";

const SR = 48_000;

function voice(partial: Partial<AudioVoice> & { startMs: number }): AudioVoice {
  return {
    id: partial.id ?? `v${partial.startMs}`,
    clip: { url: "synth:test", kind: "audio" } as AudioVoice["clip"],
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    ...partial,
  };
}

function program(
  voices: readonly AudioVoice[],
  graph?: AudioGraph,
): AudioProgram {
  return { durationMs: 400, voices, ...(graph ? { graph } : {}) };
}

async function exported(p: AudioProgram): Promise<Float32Array> {
  const mixer = new OfflineAudioMixer(
    {
      async decode() {
        throw new Error("测试里只放程序化音源");
      },
    },
    { sampleRate: SR, channels: 2 },
  );
  const [sample] = await mixer.renderProgram(p);
  return sample!.data;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
  return diff;
}

function peak(data: Float32Array): number {
  let best = 0;
  for (const v of data) best = Math.max(best, Math.abs(v));
  return best;
}

describe("双端同源：同一程序逐样本一致", () => {
  it("恒速正弦：预览路径与导出路径完全相同", async () => {
    const p = program([
      voice({
        startMs: 0,
        synth: { wave: "sine", freq: 440, durationMs: 300, gain: 0.5 },
      }),
    ]);
    const preview = await previewSamples(p, { sampleRate: SR, channels: 2 });
    expect(maxDiff(preview, await exported(p))).toBe(0);
    expect(peak(preview)).toBeGreaterThan(0.1);
  });

  it("warp 变速 + 包络：音高与时长在两端一起变", async () => {
    const p = program([
      voice({
        startMs: 20,
        gain: {
          value: 0.8,
          envelope: {
            points: [
              { atMs: 0, value: 0 },
              { atMs: 10, value: 1 },
              { atMs: 30, value: 0.5 },
              { atMs: 250, value: 0.5 },
              { atMs: 300, value: 0 },
            ],
          },
        },
        rate: {
          kind: "warp",
          points: [
            { atMs: 0, srcMs: 0 },
            { atMs: 150, srcMs: 120 },
            { atMs: 300, srcMs: 240 },
          ],
        },
        synth: { wave: "triangle", freq: 220, durationMs: 300, gain: 0.4 },
      }),
    ]);
    const preview = await previewSamples(p, { sampleRate: SR, channels: 2 });
    expect(maxDiff(preview, await exported(p))).toBe(0);
  });

  it("运行期句柄操作折进时间线：两端读同一组折点", async () => {
    const p = program([
      voice({
        startMs: 0,
        synth: { wave: "sine", freq: 330, durationMs: 300, gain: 0.6 },
        ops: [
          { kind: "gain", atMs: 100, value: 0.2, rampMs: 40 },
          { kind: "rate", atMs: 150, value: 2, rampMs: 0 },
        ],
      }),
    ]);
    const preview = await previewSamples(p, { sampleRate: SR, channels: 2 });
    expect(maxDiff(preview, await exported(p))).toBe(0);
  });

  it("噪声波形：预览与导出由同一种子给出同一串样本", async () => {
    const p = program([
      voice({
        startMs: 0,
        synth: {
          wave: "noise",
          freq: 440,
          durationMs: 200,
          gain: 0.3,
          seed: 91,
        },
      }),
    ]);
    const a = await previewSamples(p, { sampleRate: SR, channels: 2 });
    const b = await previewSamples(p, { sampleRate: SR, channels: 2 });
    expect(maxDiff(a, b)).toBe(0);
    expect(maxDiff(a, await exported(p))).toBe(0);
  });

  it("loop + 起点偏移：截断点与回卷位置两端一致", async () => {
    const p = program([
      voice({
        startMs: 30,
        loop: { untilMs: 260 },
        rate: { kind: "rate", value: 1.5 },
        synth: { wave: "saw", freq: 110, durationMs: 80, gain: 0.5 },
      }),
    ]);
    const preview = await previewSamples(p, { sampleRate: SR, channels: 2 });
    expect(maxDiff(preview, await exported(p))).toBe(0);
  });

  it("总线图（延迟 + 混响 + send）：预览听到的就是导出渲出来的", async () => {
    const graph: AudioGraph = {
      buses: [
        {
          id: "fx",
          gain: 0.8,
          pan: -0.3,
          effects: [
            { kind: "delay", delayMs: 60, feedback: 0.2, mix: 0.4 },
            { kind: "reverb", roomSize: 0.5, damping: 0.3, mix: 0.3 },
          ],
        },
      ],
      sends: [{ from: "fx", to: "master", amount: 0.25 }],
      ducks: [],
      automation: [],
    };
    const p = program(
      [
        voice({
          startMs: 0,
          bus: "fx",
          synth: { wave: "square", freq: 330, durationMs: 250, gain: 0.4 },
        }),
      ],
      graph,
    );
    const preview = await previewSamples(p, { sampleRate: SR, channels: 2 });
    expect(maxDiff(preview, await exported(p))).toBe(0);
    expect(peak(preview)).toBeGreaterThan(0.05);
  });

  it("块尺寸只影响循环次数：128 / 512 / 整段给出同一份样本", async () => {
    const p = program([
      voice({
        startMs: 0,
        synth: { wave: "sine", freq: 550, durationMs: 300, gain: 0.5 },
      }),
    ]);
    const small = await previewSamples(p, {
      sampleRate: SR,
      channels: 2,
      blockFrames: 128,
    });
    const large = await previewSamples(p, {
      sampleRate: SR,
      channels: 2,
      blockFrames: 512,
    });
    const whole = await previewSamples(p, {
      sampleRate: SR,
      channels: 2,
      blockFrames: 48_000 * 2,
    });
    expect(maxDiff(small, large)).toBe(0);
    expect(maxDiff(small, whole)).toBe(0);
  });
});
