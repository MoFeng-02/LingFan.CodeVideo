/**
 * 运行期独奏：把某条总线的 solo 经总线更新消息置真后，其余非 master 总线整块静音。
 *
 * 这里不经过真实 AudioWorklet，而是把主线程会发出的消息喂给同一内核渲染，
 * 因此覆盖的是「运行期覆盖参与独奏判定」这条路径（静态 solo 由音频图测试覆盖）。
 */
import { describe, expect, it } from "vitest";
import type { AudioVoice, BusUpdate } from "@lingfan-video/contracts";
import { renderMessages, type Captured } from "./support/worklet-harness";

const SR = 48_000;

/** 常量 PCM（单声道 0.5，长度 ms 毫秒） */
function pcm(ms: number): {
  data: Float32Array;
  sampleRate: number;
  channels: number;
  durationMs: number;
} {
  return {
    data: new Float32Array(Math.round((ms / 1000) * SR)).fill(0.5),
    sampleRate: SR,
    channels: 1,
    durationMs: ms,
  };
}

/** 一条声音声明：常量 PCM 走 a 总线或 b 总线 */
function voice(id: string, bus?: string): AudioVoice {
  return {
    id,
    clip: { url: `synth:${id}`, kind: "audio" } as AudioVoice["clip"],
    startMs: 0,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    ...(bus === undefined ? {} : { bus }),
  };
}

/**
 * 构造预览端会发出的消息序列。
 *
 * @param soloBus 要运行期独奏的总线；缺省不独奏
 * @returns init + 两条声音 + 可选的 bus 更新
 */
function messages(soloBus?: string): Captured[] {
  const init: Captured = {
    message: {
      type: "init",
      sampleRate: SR,
      channels: 1,
      durationMs: 200,
      graph: {
        buses: [{ id: "a" }, { id: "b" }],
        sends: [],
        ducks: [],
        automation: [],
      },
    },
  };
  const voices: Captured[] = [
    { message: { type: "voice", voice: voice("va", "a"), pcm: pcm(200) } },
    { message: { type: "voice", voice: voice("vb", "b"), pcm: pcm(200) } },
  ];
  if (soloBus === undefined) return [init, ...voices];
  const update: BusUpdate = {
    id: soloBus,
    gain: 1,
    pan: 0,
    mute: false,
    solo: true,
  };
  return [init, ...voices, { message: { type: "bus", update, atMs: 0 } }];
}

/** 取某个时间点的左声道样本 */
function at(data: Float32Array, ms: number): number {
  return data[Math.round((ms / 1000) * SR)]!;
}

function render(soloBus?: string): Float32Array {
  return renderMessages(messages(soloBus), {
    sampleRate: SR,
    channels: 1,
    durationMs: 200,
  });
}

describe("运行期独奏", () => {
  it("不独奏时两条总线都进 master", () => {
    expect(at(render(), 100)).toBeCloseTo(1, 6);
  });

  it("运行期 solo 置真后：未独奏的总线被静音", () => {
    // a 总线独奏，b 总线整块静音，只剩 a 的 0.5
    expect(at(render("a"), 100)).toBeCloseTo(0.5, 6);
  });
});
