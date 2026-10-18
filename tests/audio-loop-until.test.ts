/**
 * 音频循环终界：`AudioLoop.untilMs` 是时间线毫秒（绝对），不是相对声音起点的长度。
 *
 * 起点偏移后两条时间基准会明显分叉：按绝对时间线收尾，声音在 `untilMs` 处停；
 * 若误当局部毫秒，则会拖到 `startMs + untilMs`。这里用方波 + 窗口峰值检查，
 * 避免采样点恰好落在波形过零处。
 */
import { describe, expect, it } from "vitest";
import type { AudioProgram, AudioVoice } from "@lingfan-video/contracts";
import { OfflineAudioMixer } from "@lingfan-video/infra";

const SR = 48_000;

/** 构造一条带循环的声音声明（其余字段取中性值） */
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

/** 离线渲染整条程序，返回交错 PCM */
async function render(program: AudioProgram): Promise<Float32Array> {
  const mixer = new OfflineAudioMixer(
    {
      async decode() {
        throw new Error("测试里只放程序化音源");
      },
    },
    { sampleRate: SR, channels: 2 },
  );
  const [sample] = await mixer.renderProgram(program);
  return sample!.data;
}

/** 左声道在 [fromMs, toMs] 窗口内的峰值 */
function peakBetween(data: Float32Array, fromMs: number, toMs: number): number {
  const from = Math.round((fromMs / 1000) * SR);
  const to = Math.round((toMs / 1000) * SR);
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i * 2]!));
  return peak;
}

describe("音频循环终界", () => {
  it("起点偏移后 untilMs 仍按绝对时间线收尾", async () => {
    const data = await render({
      durationMs: 2000,
      voices: [
        voice({
          startMs: 1000,
          loop: { untilMs: 1500 },
          synth: { wave: "square", freq: 220, durationMs: 400, gain: 0.5 },
        }),
      ],
    });
    // 1400ms 仍在循环里（方波经合成包络后的峰值约 0.4）；
    // 1500ms 之后应完全静音（误当局部毫秒会响到 2500ms）
    expect(peakBetween(data, 1390, 1410)).toBeGreaterThan(0.3);
    expect(peakBetween(data, 1600, 1620)).toBe(0);
  });

  it("起点为 0 时 untilMs 同样是时间线毫秒", async () => {
    const data = await render({
      durationMs: 2000,
      voices: [
        voice({
          startMs: 0,
          loop: { untilMs: 1500 },
          synth: { wave: "square", freq: 220, durationMs: 400, gain: 0.5 },
        }),
      ],
    });
    expect(peakBetween(data, 1390, 1410)).toBeGreaterThan(0.3);
    expect(peakBetween(data, 1600, 1620)).toBe(0);
  });
});
