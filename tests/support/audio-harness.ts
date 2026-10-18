/**
 * 记录型 AudioContext 替身（测试专用）：预览端真正写下的节点、连线与参数自动化都留痕，
 * 供与导出端求值结果逐点比对。
 *
 * 每个替身节点都带 `id` 与 `kind`，`connect` 会记下一条边——效果链里的反馈、湿声、干声
 * 因此可以按拓扑定位，而不必依赖「第几个创建的增益」这种脆弱的顺序假设。
 * 只实现被预览端真正调用到的 API；缺的能力一律宁可断言失败，也不静默通过。
 */

import { makeParam, type ParamEvent, type ParamLike } from "./audio-params";
import type {
  BiquadRec,
  CompressorRec,
  ConvolverRec,
  DelayRec,
  Edge,
  FakeAudioBuffer,
  GainRec,
  Harness,
  NodeKind,
  OscRec,
  PannerRec,
  SourceRec,
} from "./audio-harness-types";

export { makeParam, paramAt } from "./audio-params";
export type { ParamEvent, ParamLike } from "./audio-params";
export type {
  BiquadRec,
  CompressorRec,
  ConvolverRec,
  DelayRec,
  Edge,
  FakeAudioBuffer,
  GainRec,
  Harness,
  NodeKind,
  OscRec,
  PannerRec,
  SourceRec,
} from "./audio-harness-types";

const START_SEC = 10;
const SAMPLE_RATE = 48_000;

/** 最小 AudioContext 替身：只记录预览端真正写下的节点与参数自动化 */
export function makeHarness(): Harness {
  const nodes: Array<{ id: number; kind: NodeKind }> = [];
  const edges: Edge[] = [];
  const sources: SourceRec[] = [];
  const gains: GainRec[] = [];
  const oscs: OscRec[] = [];
  const delays: DelayRec[] = [];
  const convolvers: ConvolverRec[] = [];
  const biquads: BiquadRec[] = [];
  const compressors: CompressorRec[] = [];
  const panners: PannerRec[] = [];
  const buffers: Float32Array[] = [];
  const ids = new WeakMap<object, number>();

  const nextId = (kind: NodeKind): number => {
    const id = nodes.length;
    nodes.push({ id, kind });
    return id;
  };
  const wire =
    (self: object) =>
    (target: unknown): void => {
      const from = ids.get(self)!;
      const targetId = (target as { id?: unknown } | null | undefined)?.id;
      const to = typeof targetId === "number" ? targetId : -1;
      edges.push({ from, to });
    };
  const noop = (): void => {};

  const createBuffer = (
    channels: number,
    frames: number,
    rate: number,
  ): FakeAudioBuffer => {
    const data: Float32Array[] = [];
    for (let c = 0; c < channels; c++) data.push(new Float32Array(frames));
    buffers.push(data[0]!);
    return {
      numberOfChannels: channels,
      length: frames,
      sampleRate: rate,
      getChannelData: (channel: number) => data[channel]!,
    };
  };

  const ctx = {
    currentTime: START_SEC,
    sampleRate: SAMPLE_RATE,
    destination: { id: -1 },
    baseLatency: 0,
    outputLatency: 0,
    createBuffer(channels: number, frames: number) {
      return createBuffer(channels, frames, SAMPLE_RATE);
    },
    createBufferSource(): AudioBufferSourceNode {
      const rec: { value: number } = { value: 1 };
      const events: ParamEvent[] = [];
      const node: SourceRec = {
        id: nextId("source"),
        kind: "source" as const,
        loop: false,
        buffer: null as FakeAudioBuffer | null,
        rate: events,
        playbackRate: makeParam(events, rec),
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
        start(at: number, offset = 0) {
          node.startAt = at;
          node.offset = offset;
        },
        stop(at?: number) {
          node.stopAt = at;
        },
      };
      ids.set(node, node.id);
      sources.push(node);
      return node as unknown as AudioBufferSourceNode;
    },
    createGain(): GainNode {
      const rec: { value: number } = { value: 1 };
      const events: ParamEvent[] = [];
      const node: GainRec = {
        id: nextId("gain"),
        kind: "gain" as const,
        events,
        gain: makeParam(events, rec),
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
      };
      ids.set(node, node.id);
      gains.push(node);
      return node as unknown as GainNode;
    },
    createOscillator(): OscillatorNode {
      const freq: { value: number } = { value: 440 };
      const detune: { value: number } = { value: 0 };
      const detuneEvents: ParamEvent[] = [];
      const node: OscRec = {
        id: nextId("oscillator"),
        kind: "oscillator" as const,
        type: "sine",
        frequency: makeParam([], freq),
        detune: makeParam(detuneEvents, detune),
        detuneEvents,
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
        start(at: number) {
          node.startAt = at;
        },
        stop(at?: number) {
          node.stopAt = at;
        },
      };
      ids.set(node, node.id);
      oscs.push(node);
      return node as unknown as OscillatorNode;
    },
    createDelay(maxDelayTime: number): DelayNode {
      const rec: { value: number } = { value: 0 };
      const delayEvents: ParamEvent[] = [];
      const node: DelayRec = {
        id: nextId("delay"),
        kind: "delay" as const,
        maxDelayTime,
        delayEvents,
        delayTime: makeParam(delayEvents, rec),
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
      };
      ids.set(node, node.id);
      delays.push(node);
      return node as unknown as DelayNode;
    },
    createConvolver(): ConvolverNode {
      const node: ConvolverRec = {
        id: nextId("convolver"),
        kind: "convolver" as const,
        buffer: null as FakeAudioBuffer | null,
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
      };
      ids.set(node, node.id);
      convolvers.push(node);
      return node as unknown as ConvolverNode;
    },
    createBiquadFilter(): BiquadFilterNode {
      const freq: { value: number } = { value: 350 };
      const q: { value: number } = { value: 1 };
      const node: BiquadRec = {
        id: nextId("biquad"),
        kind: "biquad" as const,
        type: "lowpass",
        frequency: makeParam([], freq),
        Q: makeParam([], q),
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
      };
      ids.set(node, node.id);
      biquads.push(node);
      return node as unknown as BiquadFilterNode;
    },
    createDynamicsCompressor(): DynamicsCompressorNode {
      const mk = (
        value: number,
      ): { rec: { value: number }; param: ParamLike } => {
        const rec = { value };
        return { rec, param: makeParam([], rec) };
      };
      const threshold = mk(-24);
      const ratio = mk(12);
      const attack = mk(0.003);
      const release = mk(0.25);
      const knee = mk(30);
      const node: CompressorRec = {
        id: nextId("compressor"),
        kind: "compressor" as const,
        threshold: threshold.param,
        ratio: ratio.param,
        attack: attack.param,
        release: release.param,
        knee: knee.param,
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
      };
      ids.set(node, node.id);
      compressors.push(node);
      return node as unknown as DynamicsCompressorNode;
    },
    createStereoPanner(): StereoPannerNode {
      const rec: { value: number } = { value: 0 };
      const node: PannerRec = {
        id: nextId("panner"),
        kind: "panner" as const,
        pan: makeParam([], rec),
        connect(target: unknown) {
          wire(node)(target);
        },
        disconnect: noop,
      };
      ids.set(node, node.id);
      panners.push(node);
      return node as unknown as StereoPannerNode;
    },
  };

  return {
    ctx: ctx as unknown as AudioContext,
    sources,
    gains,
    oscs,
    delays,
    convolvers,
    biquads,
    compressors,
    panners,
    buffers,
    edges,
    kindOf: (id: number) => nodes[id]?.kind,
    inputsOf: (id: number) =>
      edges.filter((e) => e.to === id).map((e) => e.from),
    outputsOf: (id: number) =>
      edges.filter((e) => e.from === id).map((e) => e.to),
  };
}

/** 让预加载/解码回调先跑完（预览端在自己排程里是异步的） */
export const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
