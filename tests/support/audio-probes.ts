/**
 * 双端比对用的探针：把「预览端建了什么图」与「导出端就地 DSP 输出了什么」变成可比较的数字。
 *
 * 定位节点一律按连线拓扑（谁读谁、谁送回谁），不依赖创建顺序；这样效果链里反馈、湿声、
 * 干声的位置由结构本身决定，链序变了断言就会失败，而不是悄悄错位。
 */
import type {
  AudioGraph,
  AudioProgram,
  AudioVoice,
  SynthSpec,
} from "@lingfan-video/contracts";
import { WebAudioOutput } from "@lingfan-video/infra";
import { mixProgram } from "../../packages/infra/src/audio/dsp";
import {
  flush,
  makeHarness,
  type FakeAudioBuffer,
  type Harness,
} from "./audio-harness";

export const SR = 48_000;
export const TAU = Math.PI * 2;

export function graphOf(
  buses: AudioGraph["buses"],
  extra?: Partial<AudioGraph>,
): AudioGraph {
  return { buses, sends: [], ducks: [], automation: [], ...extra };
}

/** 用记录型 AudioContext 跑一遍预览端建图 */
export async function previewBus(
  graph: AudioGraph,
  durationMs = 1000,
  voices: AudioVoice[] = [],
): Promise<Harness> {
  const h = makeHarness();
  const out = new WebAudioOutput(
    h.ctx,
    async () => ({ duration: 0 }) as AudioBuffer,
  );
  await out.begin({ durationMs, voices, graph } as AudioProgram);
  await flush();
  return h;
}

/**
 * 导出端：把单个冲激铺进总线，取回总线输出。
 * `layoutVoice` 只负责往输入里放一个冲激，其余交给被测的总线图，效果的时序因此可以单独观察。
 */
export function renderImpulse(
  graph: AudioGraph,
  options: { frames?: number; amp?: number } = {},
): Float32Array {
  const frames = options.frames ?? SR;
  const amp = options.amp ?? 1;
  const voice: AudioVoice = {
    id: "impulse",
    clip: { url: "clip", kind: "audio" } as AudioVoice["clip"],
    startMs: 0,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    bus: "fx",
  };
  // 一帧的 PCM 冲激：单帧源时长 = 1/SR 毫秒，铺轨时只在第 0 帧写入
  return mixProgram({
    sampleRate: SR,
    channels: 2,
    durationMs: (frames / SR) * 1000,
    graph,
    voices: [
      {
        voice,
        pcm: {
          data: new Float32Array([amp, amp]),
          sampleRate: SR,
          channels: 2,
          durationMs: (1 / SR) * 1000,
        },
      },
    ],
  });
}

/** 左声道幅值最大处所在样本（用于量延迟） */
export function peakIndex(data: Float32Array): number {
  let best = 0;
  let index = 0;
  for (let i = 0; i < data.length / 2; i++) {
    const v = Math.abs(data[i * 2]!);
    if (v > best) {
      best = v;
      index = i;
    }
  }
  return index;
}

export function energy(
  data: Float32Array,
  fromMs: number,
  toMs: number,
  channel = 0,
): number {
  const from = Math.max(0, Math.round((fromMs / 1000) * SR));
  const to = Math.min(
    Math.floor(data.length / 2),
    Math.round((toMs / 1000) * SR),
  );
  let sum = 0;
  for (let i = from; i < to; i++) sum += Math.abs(data[i * 2 + channel]!);
  return sum;
}

/** 单频点的 DFT 幅值（整数周期窗口，避免泄漏） */
export function toneMagnitude(
  data: Float32Array,
  freq: number,
  fromMs: number,
  toMs: number,
): number {
  const from = Math.round((fromMs / 1000) * SR);
  const to = Math.min(data.length, Math.round((toMs / 1000) * SR));
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const phase = (TAU * freq * i) / SR;
    re += data[i]! * Math.cos(phase);
    im -= data[i]! * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

export function zeroCrossRate(
  data: Float32Array,
  fromMs: number,
  toMs: number,
  channel = 0,
): number {
  const from = Math.round((fromMs / 1000) * SR);
  const to = Math.min(data.length / 2, Math.round((toMs / 1000) * SR));
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    const a = data[(i - 1) * 2 + channel]!;
    const b = data[i * 2 + channel]!;
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings++;
  }
  return (crossings * SR) / (2 * (to - from));
}

export function synthVoice(
  spec: SynthSpec,
  extra?: Partial<AudioVoice>,
): AudioVoice {
  return {
    id: "s",
    clip: { url: "synth:inline", kind: "audio" } as AudioVoice["clip"],
    startMs: 0,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    synth: spec,
    ...extra,
  };
}

/** 排程单个程序化声音并抓回它在预览端建的振荡器 */
export async function previewSynthVoice(voice: AudioVoice, durationMs: number) {
  const h = makeHarness();
  const out = new WebAudioOutput(
    h.ctx,
    async () => ({ duration: 0 }) as AudioBuffer,
  );
  await out.begin({ durationMs, voices: [voice] } as AudioProgram);
  await flush();
  const osc = h.oscs[0];
  if (!osc) throw new Error("预览端没有建振荡器");
  return { osc };
}

/** `FakeAudioBuffer` 在这里只作为类型占位，供调用方断言 IR 内容 */
export type { FakeAudioBuffer };
