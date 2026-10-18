/**
 * 预览端适配器：它不再自己搭节点，而是把程序（图 + 声音 PCM）投递给音频线程。
 * 这里检查消息形状与生命周期：init 先到、PCM 同源、运行期句柄带时间线时刻、
 * 上下文不支持 AudioWorklet 时显式报错而不是静默降级。
 */
import { describe, expect, it } from "vitest";
import type { AudioProgram, AudioVoice } from "@lingfan-video/contracts";
import { WebAudioOutput } from "@lingfan-video/infra";
import { renderSynth } from "../packages/infra/src/audio/synth";
import { flush, makeHarness } from "./support/audio-harness";
import { installWorklet } from "./support/worklet-harness";

const SR = 48_000;

function voice(partial: Partial<AudioVoice> = {}): AudioVoice {
  return {
    id: "v0",
    clip: { url: "synth:test", kind: "audio" } as AudioVoice["clip"],
    startMs: 0,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    synth: { wave: "sine", freq: 440, durationMs: 100, gain: 0.5 },
    ...partial,
  };
}

function program(voices: readonly AudioVoice[]): AudioProgram {
  return { durationMs: 500, voices };
}

const noClips = (): Promise<AudioBuffer> =>
  Promise.reject(new Error("测试不加载素材"));

describe("预览适配器：程序投递", () => {
  it("begin 先发 init：采样率、声道、时长与空图", async () => {
    const cap = installWorklet();
    try {
      await new WebAudioOutput(
        cap.harness.ctx as unknown as AudioContext,
        noClips,
      ).begin(program([]));
      const init = cap.messages[0]!.message;
      expect(init.type).toBe("init");
      if (init.type !== "init") throw new Error("首条消息必须是 init");
      expect(init.sampleRate).toBe(SR);
      expect(init.channels).toBe(2);
      expect(init.durationMs).toBe(500);
      expect(init.graph.buses).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it("声音按程序顺序投递，synth 的 PCM 就是导出的合成结果", async () => {
    const cap = installWorklet();
    try {
      const spec = {
        wave: "sine",
        freq: 440,
        durationMs: 100,
        gain: 0.5,
      } as const;
      const a = voice({ id: "a", synth: spec });
      const b = voice({ id: "b", startMs: 120, synth: spec });
      await new WebAudioOutput(
        cap.harness.ctx as unknown as AudioContext,
        noClips,
      ).begin(program([a, b]));
      const voices = cap.messages.filter((m) => m.message.type === "voice");
      expect(voices).toHaveLength(2);
      const first = voices[0]!.message;
      if (first.type !== "voice") throw new Error("应为声音消息");
      expect(first.voice.id).toBe("a");
      const expected = renderSynth(spec, SR, 2);
      expect(first.pcm.channels).toBe(2);
      expect(first.pcm.data.length).toBe(expected.data.length);
      for (let i = 0; i < expected.data.length; i++)
        expect(first.pcm.data[i]).toBe(expected.data[i]!);
      expect(voices[0]!.transfer).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  it("素材声音经加载器转成交错 PCM：单声道复制到两路", async () => {
    const cap = installWorklet();
    try {
      const pcm = new Float32Array(100).fill(0.25);
      const loader = (): Promise<AudioBuffer> =>
        Promise.resolve({
          length: pcm.length,
          sampleRate: SR,
          numberOfChannels: 1,
          getChannelData: () => pcm,
        } as unknown as AudioBuffer);
      await new WebAudioOutput(
        cap.harness.ctx as unknown as AudioContext,
        loader,
      ).begin(
        program([
          voice({
            synth: undefined,
            clip: { url: "clip:a", kind: "audio" } as AudioVoice["clip"],
          }),
        ]),
      );
      const shipped = cap.messages.find(
        (m) => m.message.type === "voice",
      )!.message;
      if (shipped.type !== "voice") throw new Error("应为声音消息");
      expect(shipped.pcm.channels).toBe(2);
      expect(shipped.pcm.data.length).toBe(pcm.length * 2);
      expect(shipped.pcm.data[0]).toBe(0.25);
      expect(shipped.pcm.data[1]).toBe(0.25);
    } finally {
      cap.restore();
    }
  });

  it("dispose 之后再 start：不再投递任何消息", async () => {
    const cap = installWorklet();
    try {
      const output = new WebAudioOutput(
        cap.harness.ctx as unknown as AudioContext,
        noClips,
      );
      await output.begin(program([]));
      const before = cap.messages.length;
      output.dispose();
      output.start(voice());
      await flush();
      expect(cap.messages.length).toBe(before);
    } finally {
      cap.restore();
    }
  });

  it("运行期 start：句柄操作以时间线毫秒投递", async () => {
    const cap = installWorklet();
    try {
      const output = new WebAudioOutput(
        cap.harness.ctx as unknown as AudioContext,
        noClips,
      );
      await output.begin(program([]));
      const live = output.start(voice({ id: "live" }));
      await flush();
      live.setGain(120, 0.5, 30);
      live.setRate(200, 1.5, 0);
      live.stop(300, 20);
      const tail = cap.messages.slice(-3).map((m) => m.message);
      expect(tail[0]).toMatchObject({
        type: "gain",
        voiceId: "live",
        atMs: 120,
        value: 0.5,
        rampMs: 30,
      });
      expect(tail[1]).toMatchObject({
        type: "rate",
        voiceId: "live",
        atMs: 200,
        value: 1.5,
      });
      expect(tail[2]).toMatchObject({
        type: "stop",
        voiceId: "live",
        atMs: 300,
        fadeMs: 20,
      });
    } finally {
      cap.restore();
    }
  });

  it("上下文不支持 AudioWorklet：显式报错，不静默降级", async () => {
    const h = makeHarness();
    const output = new WebAudioOutput(
      h.ctx as unknown as AudioContext,
      noClips,
    );
    await expect(output.begin(program([]))).rejects.toThrow(/AudioWorklet/);
  });
});
