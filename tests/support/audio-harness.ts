/**
 * 记录型 AudioContext 替身（测试专用）：预览端真正写下的节点、连线与参数自动化都留痕，
 * 供与导出端求值结果逐点比对。
 *
 * 每个替身节点都带 `id` 与 `kind`，`connect` 会记下一条边——效果链里的反馈、湿声、干声
 * 因此可以按拓扑定位，而不必依赖「第几个创建的增益」这种脆弱的顺序假设。
 * 只实现被预览端真正调用到的 API；缺的能力一律宁可断言失败，也不静默通过。
 */

const START_SEC = 10;
const SAMPLE_RATE = 48_000;

export interface ParamEvent {
  readonly value: number;
  readonly at: number;
  readonly ramp: boolean;
}

export interface ParamLike {
  value: number;
  setValueAtTime(value: number, at: number): void;
  linearRampToValueAtTime(value: number, at: number): void;
  cancelScheduledValues(at?: number): void;
}

export type NodeKind =
  | "gain"
  | "source"
  | "oscillator"
  | "delay"
  | "convolver"
  | "biquad"
  | "compressor"
  | "panner";

export interface Edge {
  readonly from: number;
  readonly to: number;
}

export interface SourceRec {
  readonly id: number;
  readonly kind: "source";
  loop: boolean;
  startAt?: number;
  offset?: number;
  stopAt?: number;
  /** playbackRate 的自动化事件（与导出端速率表比对） */
  readonly rate: ParamEvent[];
  buffer: FakeAudioBuffer | null;
  playbackRate: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
  start(at: number, offset?: number): void;
  stop(at?: number): void;
}

export interface GainRec {
  readonly id: number;
  readonly kind: "gain";
  /** 写在增益上的自动化事件 */
  readonly events: ParamEvent[];
  gain: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface OscRec {
  readonly id: number;
  readonly kind: "oscillator";
  type: string;
  startAt?: number;
  stopAt?: number;
  frequency: ParamLike;
  detune: ParamLike;
  /** detune 的自动化事件（预览端把运行期变速写成音分） */
  readonly detuneEvents: ParamEvent[];
  connect(target: unknown): void;
  disconnect(): void;
  start(at: number): void;
  stop(at?: number): void;
}

export interface DelayRec {
  readonly id: number;
  readonly kind: "delay";
  readonly maxDelayTime: number;
  readonly delayTime: ParamLike;
  readonly delayEvents: ParamEvent[];
  connect(target: unknown): void;
  disconnect(): void;
}

export interface ConvolverRec {
  readonly id: number;
  readonly kind: "convolver";
  buffer: FakeAudioBuffer | null;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface BiquadRec {
  readonly id: number;
  readonly kind: "biquad";
  type: string;
  frequency: ParamLike;
  Q: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface CompressorRec {
  readonly id: number;
  readonly kind: "compressor";
  threshold: ParamLike;
  ratio: ParamLike;
  attack: ParamLike;
  release: ParamLike;
  knee: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

export interface PannerRec {
  readonly id: number;
  readonly kind: "panner";
  pan: ParamLike;
  connect(target: unknown): void;
  disconnect(): void;
}

/** 预览端从 AudioContext 拿到的最小缓冲形态（含逐声道样本，供 IR/噪声比对） */
export interface FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface Harness {
  readonly ctx: AudioContext;
  readonly sources: SourceRec[];
  readonly gains: GainRec[];
  readonly oscs: OscRec[];
  readonly delays: DelayRec[];
  readonly convolvers: ConvolverRec[];
  readonly biquads: BiquadRec[];
  readonly compressors: CompressorRec[];
  readonly panners: PannerRec[];
  /** 每次 createBuffer 的 0 声道样本（噪声/IR 逐样本比对的入口） */
  readonly buffers: Float32Array[];
  /** 节点间连线（预览端拓扑） */
  readonly edges: readonly Edge[];
  /** 节点类型（按 id 查） */
  kindOf(id: number): NodeKind | undefined;
  /** 指向 `id` 的边的来源节点 id（即 `id` 的输入） */
  inputsOf(id: number): number[];
  /** 从 `id` 流出的边的目标节点 id */
  outputsOf(id: number): number[];
}

/** AudioParam 语义替身：`.value` 直接赋值即时生效（不产生自动化事件） */
export function makeParam(
  events: ParamEvent[],
  rec: { value: number },
): ParamLike {
  return {
    get value() {
      return rec.value;
    },
    set value(v: number) {
      rec.value = v;
    },
    setValueAtTime(value: number, at: number) {
      rec.value = value;
      events.push({ value, at, ramp: false });
    },
    linearRampToValueAtTime(value: number, at: number) {
      rec.value = value;
      events.push({ value, at, ramp: true });
    },
    cancelScheduledValues() {},
  };
}

/**
 * AudioParam 语义求值：`set` 事件把值保持到下一个事件；
 * `ramp` 事件与上一个事件之间线性插值（WebAudio 的 linearRampToValueAtTime 口径）。
 */
export function paramAt(events: readonly ParamEvent[], sec: number): number {
  let anchorAt = Number.NEGATIVE_INFINITY;
  let anchorValue = 1;
  for (const e of events) {
    if (e.at > sec) {
      if (e.ramp && Number.isFinite(anchorAt) && e.at > anchorAt) {
        const k = (sec - anchorAt) / (e.at - anchorAt);
        return anchorValue + (e.value - anchorValue) * k;
      }
      return anchorValue;
    }
    anchorAt = e.at;
    anchorValue = e.value;
  }
  return anchorValue;
}

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
      sources.push(node as unknown as SourceRec);
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
      gains.push(node as unknown as GainRec);
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
      oscs.push(node as unknown as OscRec);
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
      delays.push(node as unknown as DelayRec);
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
      convolvers.push(node as unknown as ConvolverRec);
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
      biquads.push(node as unknown as BiquadRec);
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
      compressors.push(node as unknown as CompressorRec);
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
      panners.push(node as unknown as PannerRec);
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
