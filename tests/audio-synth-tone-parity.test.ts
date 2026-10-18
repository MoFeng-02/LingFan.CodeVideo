/**
 * 音色：程序化音源在导出端是逐样本合成，预览端把同一份 PCM 交给音频线程。
 * 这里检查合成本身的解析正确性与混叠，以及「速率」在两端是同一个重采样语义。
 */
import { describe, expect, it } from "vitest";
import type {
  AudioProgram,
  AudioVoice,
  SynthSpec,
} from "@lingfan-video/contracts";
import { OfflineAudioMixer } from "@lingfan-video/infra";
import { renderSynth } from "../packages/infra/src/audio/synth";
import { previewSamples } from "./support/worklet-harness";
import {
  energy,
  SR,
  synthVoice,
  TAU,
  toneMagnitude,
  zeroCrossRate,
} from "./support/audio-probes";

const FLAT: SynthSpec["envelope"] = {
  attackMs: 0,
  decayMs: 0,
  sustain: 1,
  releaseMs: 0,
};

async function exported(p: AudioProgram): Promise<Float32Array> {
  const mixer = new OfflineAudioMixer(
    {
      async decode() {
        throw new Error("synth 不应走素材解码");
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

describe("音色：波形", () => {
  it("正弦：合成结果与解析式逐样本一致", () => {
    const spec: SynthSpec = {
      wave: "sine",
      freq: 440,
      durationMs: 100,
      gain: 0.5,
      envelope: FLAT,
    };
    const pcm = renderSynth(spec, SR, 1);
    for (const i of [1, 100, 1234, pcm.data.length - 1]) {
      const expected = Math.sin((TAU * 440 * i) / SR) * 0.5;
      expect(pcm.data[i]!).toBeCloseTo(expected, 6);
    }
  });

  it("非正弦：朴素波形带混叠，折回分量真实存在", () => {
    const frames = SR / 2;
    const spec: SynthSpec = {
      wave: "square",
      freq: 11_000,
      durationMs: 500,
      gain: 1,
      envelope: FLAT,
    };
    const square = renderSynth(spec, SR, 1).data;
    // 11kHz 方波的 5 次谐波 55kHz 越过奈奎斯特，折回 7kHz
    const alias = toneMagnitude(square, 7_000, 50, 450);
    const reference = toneMagnitude(square, 11_000, 50, 450);
    expect(alias).toBeGreaterThan(0.05);
    expect(alias / reference).toBeGreaterThan(0.1);

    const sine = renderSynth({ ...spec, wave: "sine" }, SR, 1).data;
    expect(toneMagnitude(sine, 7_000, 50, 450)).toBeLessThan(1e-6);
    expect(sine.length).toBe(frames);
  });
});

describe("音色：声音速率", () => {
  it("速率 2：两端按同一个重采样速率把音高抬一个八度、时长减半", async () => {
    const spec: SynthSpec = {
      wave: "sine",
      freq: 440,
      durationMs: 400,
      gain: 0.5,
      envelope: FLAT,
    };
    const rate = { kind: "rate", value: 2 } as AudioVoice["rate"];
    const program: AudioProgram = {
      durationMs: 400,
      voices: [synthVoice(spec, { rate })],
    };
    const data = await exported(program);
    expect(zeroCrossRate(data, 20, 180)).toBeCloseTo(880, -1);
    expect(energy(data, 20, 180)).toBeGreaterThan(1);
    expect(energy(data, 260, 400)).toBeLessThan(1e-3);

    const preview = await previewSamples(program, {
      sampleRate: SR,
      channels: 2,
    });
    expect(maxDiff(preview, data)).toBe(0);
  });

  it("运行期 setRate：预览投递的操作与导出端的重采样同一落点", async () => {
    const spec: SynthSpec = {
      wave: "sine",
      freq: 440,
      durationMs: 400,
      gain: 0.5,
      envelope: FLAT,
    };
    const base = synthVoice(spec);
    const withOp: AudioProgram = {
      durationMs: 400,
      voices: [
        {
          ...base,
          ops: [{ kind: "rate", atMs: 0, value: 1.5, rampMs: 0 }],
        },
      ],
    };
    const preview = await previewSamples(withOp, {
      sampleRate: SR,
      channels: 2,
    });
    expect(maxDiff(preview, await exported(withOp))).toBe(0);
    // 倍率 1.5 → 660Hz，仍在 400ms 窗口里
    expect(zeroCrossRate(preview, 20, 180)).toBeCloseTo(660, -1);
  });
});
