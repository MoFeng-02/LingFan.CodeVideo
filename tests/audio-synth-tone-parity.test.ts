/**
 * 音色同源清点：程序化音源在预览端（OscillatorNode / AudioBuffer）与导出端（逐样本合成）
 * 各自落到什么波形、什么频率上。
 *
 * 三档分野：正弦可证同源；非正弦是「带限 vs 朴素」，差异集中在高频；声音速率在预览端
 * 只改音高、在导出端改重采样速率——时长同源、音高不同，属语义不一致。
 */
import { describe, expect, it } from "vitest";
import type {
  AudioProgram,
  AudioVoice,
  SynthSpec,
} from "@lingfan-video/contracts";
import { OfflineAudioMixer, WebAudioOutput } from "@lingfan-video/infra";
import { renderSynth } from "../packages/infra/src/audio/synth";
import { makeHarness } from "./support/audio-harness";
import {
  energy,
  lastEvent,
  previewSynthVoice,
  SR,
  synthVoice,
  TAU,
  toneMagnitude,
  zeroCrossRate,
} from "./support/audio-probes";

describe("音色同源：波形", () => {
  it("正弦：导出端合成与解析式逐样本一致", () => {
    const spec: SynthSpec = {
      wave: "sine",
      freq: 440,
      durationMs: 100,
      gain: 0.5,
      envelope: { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 },
    };
    const pcm = renderSynth(spec, SR, 1);
    for (const i of [1, 100, 1234, pcm.data.length - 1]) {
      const expected = Math.sin((TAU * 440 * i) / SR) * 0.5;
      expect(pcm.data[i]!).toBeCloseTo(expected, 6);
    }
  });

  it("非正弦：导出端是朴素波形，混叠分量真实存在", () => {
    const frames = SR / 2;
    const spec: SynthSpec = {
      wave: "square",
      freq: 11_000,
      durationMs: 500,
      gain: 1,
      envelope: { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 },
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

describe("音色同源：声音速率", () => {
  it("速率：预览端不读它，导出端按它重采样——时长同源、音高不同", async () => {
    const spec: SynthSpec = {
      wave: "sine",
      freq: 440,
      durationMs: 400,
      gain: 0.5,
      envelope: { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 },
    };
    const rate = { kind: "rate", value: 2 } as AudioVoice["rate"];
    const voice = synthVoice(spec, { rate });
    const preview = await previewSynthVoice(voice, 1000);
    // 预览端：振荡器仍在 440Hz，且没有被写入任何速率自动化
    expect(preview.osc.frequency.value).toBe(440);
    expect(preview.osc.detuneEvents).toHaveLength(0);
    // 终点与导出端同源：速率让声音在时间线上占一半
    expect(preview.osc.stopAt! - preview.osc.startAt!).toBeCloseTo(0.2, 6);

    const mixer = new OfflineAudioMixer(
      {
        async decode() {
          throw new Error("synth 不应走素材解码");
        },
      },
      { sampleRate: SR, channels: 2 },
    );
    const [sample] = await mixer.renderProgram({
      durationMs: 400,
      voices: [synthVoice(spec, { rate })],
    } as AudioProgram);
    const data = sample!.data;
    // 导出端：重采样把音高抬到两倍（一个八度），并在 200ms 处收尾
    expect(zeroCrossRate(data, 20, 180)).toBeCloseTo(880, -1);
    expect(energy(data, 20, 180)).toBeGreaterThan(1);
    expect(energy(data, 260, 400)).toBeLessThan(1e-3);
  });

  it("运行期变速：预览把倍率折算成音分，导出折算成重采样速率", async () => {
    const h = makeHarness();
    const out = new WebAudioOutput(
      h.ctx,
      async () => ({ duration: 0 }) as AudioBuffer,
    );
    await out.begin({ durationMs: 1000, voices: [] } as AudioProgram);
    const live = out.start(
      synthVoice({
        wave: "sine",
        freq: 440,
        durationMs: 400,
        gain: 0.5,
      }),
    );
    live.setRate(0, 1.5, 1);
    const osc = h.oscs[0]!;
    const event = lastEvent(osc.detuneEvents)!;
    expect(event.value).toBeCloseTo(1200 * Math.log2(1.5), 6);
    // 同一倍率在导出端是重采样速率：音高与时长同改；预览端只改音高
    expect(1200 * Math.log2(1.5)).toBeCloseTo(701.955, 3);
    expect(osc.stopAt! - osc.startAt!).toBeCloseTo(0.4, 6);
  });
});
