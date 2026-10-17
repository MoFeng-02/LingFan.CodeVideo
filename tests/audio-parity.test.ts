/**
 * 双端音频等价性度量：同一份声音从「唯一求值点」`evaluateVoice` 出发，
 * 导出端逐样本读 `gainAt/sourceMsAt`，预览端把同一组折点写成 AudioParam 自动化。
 * 本文件用一个记录型 AudioContext 替身抓下预览端的自动化事件，
 * 再按 AudioParam 语义求值，与导出端的求值函数逐点比对——两者的差就是双端漂移量。
 *
 * 允差只由浮点换算决定（毫秒 ↔ 上下文秒）；结构性差异必须为 0：
 * 若哪天预览改用自己的折点推导，断言会立刻失败。
 */
import { describe, expect, it } from "vitest";
import type {
  AudioProgram,
  AudioVoice,
  Ms,
  SynthSpec,
} from "@lingfan-video/contracts";
import {
  WebAudioOutput,
  evaluateVoice,
  renderSynth,
  synthEnvelopeAt,
} from "@lingfan-video/infra";

const START_CTX_SEC = 10;
/** 与实现一致的预排提前量（秒） */
const LEAD_SEC = 0.06;
const T0 = START_CTX_SEC + LEAD_SEC;
/** 采样网格步长（毫秒）：5ms 足以跨过实现里的任意折点 */
const STEP_MS = 5;
/** 毫秒 ↔ 上下文秒往返换算的浮点误差上限 */
const EPS = 1e-6;

interface ParamEvent {
  value: number;
  at: number;
  ramp: boolean;
}

interface SourceRec {
  loop: boolean;
  startAt?: number;
  offset?: number;
  stopAt?: number;
  rate: ParamEvent[];
}

interface GainRec {
  events: ParamEvent[];
}

interface OscRec {
  startAt?: number;
  stopAt?: number;
}

/** 最小 AudioContext 替身：只记录预览端真正写下的节点与参数自动化 */
function makeHarness() {
  const sources: SourceRec[] = [];
  const gains: GainRec[] = [];
  const oscs: OscRec[] = [];
  /** 噪声源缓冲：预览端按同一套伪随机序列填样，可与导出端逐样本比对 */
  const buffers: Float32Array[] = [];
  const param = (events: ParamEvent[], rec: { value: number }) => ({
    get value() {
      return rec.value;
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
  });
  const ctx = {
    currentTime: START_CTX_SEC,
    sampleRate: 48_000,
    destination: {},
    createBuffer(channels: number, frames: number) {
      const data = new Float32Array(frames);
      buffers.push(data);
      return {
        numberOfChannels: channels,
        length: frames,
        getChannelData: () => data,
      } as unknown as AudioBuffer;
    },
    createBufferSource() {
      const rec: SourceRec = { loop: false, rate: [] };
      sources.push(rec);
      const rateRec = { value: 1 };
      return {
        buffer: null as AudioBuffer | null,
        get loop() {
          return rec.loop;
        },
        set loop(v: boolean) {
          rec.loop = v;
        },
        playbackRate: param(rec.rate, rateRec),
        connect() {},
        disconnect() {},
        start(at: number, offset = 0) {
          rec.startAt = at;
          rec.offset = offset;
        },
        stop(at?: number) {
          rec.stopAt = at;
        },
      };
    },
    createGain() {
      const rec: GainRec = { events: [] };
      gains.push(rec);
      return {
        gain: param(rec.events, { value: 1 }),
        connect() {},
        disconnect() {},
      };
    },
    createStereoPanner() {
      return { pan: { value: 0 }, connect() {}, disconnect() {} };
    },
    createOscillator() {
      const rec: OscRec = {};
      oscs.push(rec);
      return {
        type: "sine",
        frequency: { value: 440 },
        detune: { value: 0 },
        connect() {},
        disconnect() {},
        start(at: number) {
          rec.startAt = at;
        },
        stop(at?: number) {
          rec.stopAt = at;
        },
      };
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources, gains, oscs, buffers };
}

/**
 * AudioParam 语义求值：`set` 事件把值保持到下一个事件；
 * `ramp` 事件与上一个事件之间线性插值（WebAudio 的 linearRampToValueAtTime 口径）。
 */
function paramAt(events: readonly ParamEvent[], sec: number): number {
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

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

interface Preview {
  source: SourceRec;
  gainEvents: readonly ParamEvent[];
}

/** 把单个声音按预览端真实路径排程，抓回它写下的节点与自动化 */
async function previewOf(
  voice: AudioVoice,
  clipSec: number,
  durationMs: Ms,
): Promise<Preview> {
  const h = makeHarness();
  const out = new WebAudioOutput(
    h.ctx,
    async () => ({ duration: clipSec }) as AudioBuffer,
  );
  await out.begin({ durationMs, voices: [voice] } as AudioProgram);
  await flush();
  // 无总线图时只会建两条母线增益（master 的 input 与 gain），其后才是声音增益
  expect(h.gains).toHaveLength(3);
  expect(h.sources).toHaveLength(1);
  return {
    source: h.sources[0]!,
    gainEvents: h.gains[2]!.events,
  };
}

/**
 * 程序化音源走振荡器分支：只建母线增益与声音增益，不加载素材缓冲。
 * 返回声音增益上写下的自动化事件。
 */
async function previewSynthOf(
  voice: AudioVoice,
  durationMs: Ms,
): Promise<{
  ampEvents: readonly ParamEvent[];
  gainEvents: readonly ParamEvent[];
}> {
  const h = makeHarness();
  const out = new WebAudioOutput(
    h.ctx,
    async () => ({ duration: 0 }) as AudioBuffer,
  );
  await out.begin({ durationMs, voices: [voice] } as AudioProgram);
  await flush();
  // 母线两条增益 + 包络增益 + 声音增益（包络与声音增益串联，乘积与导出端一致）
  expect(h.gains).toHaveLength(4);
  expect(h.oscs).toHaveLength(1);
  // 包络增益与声音增益串联：预览端振幅 = 两条自动化之积
  return { ampEvents: h.gains[2]!.events, gainEvents: h.gains[3]!.events };
}

/**
 * 噪声波形走缓冲分支：预览端自己按种子填样，导出端按同一种子合成。
 * 返回预览端真实写进音频缓冲的样本，供与导出端逐样本比对。
 */
async function previewNoiseOf(
  voice: AudioVoice,
  durationMs: Ms,
): Promise<Float32Array> {
  const h = makeHarness();
  const out = new WebAudioOutput(
    h.ctx,
    async () => ({ duration: 0 }) as AudioBuffer,
  );
  await out.begin({ durationMs, voices: [voice] } as AudioProgram);
  await flush();
  // 母线两条增益 + 包络增益 + 声音增益；噪声源是缓冲节点而非振荡器
  expect(h.gains).toHaveLength(4);
  expect(h.sources).toHaveLength(1);
  expect(h.oscs).toHaveLength(0);
  return h.buffers[0]!;
}

/** 求两个求值函数在 [from, to) 网格上的最大绝对差 */ function maxDelta(
  from: Ms,
  to: Ms,
  a: (ms: Ms) => number,
  b: (ms: Ms) => number,
): number {
  let worst = 0;
  for (let ms = from; ms < to - EPS; ms += STEP_MS) {
    worst = Math.max(worst, Math.abs(a(ms) - b(ms)));
  }
  return worst;
}

function voice(extra: Partial<AudioVoice>): AudioVoice {
  return {
    id: "v",
    clip: { url: "clip", kind: "audio" } as AudioVoice["clip"],
    startMs: 0,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    ...extra,
  };
}

describe("双端音频等价性", () => {
  it("恒速声音：预览的增益自动化与导出端逐点一致", async () => {
    const v = voice({ gain: { value: 1, fadeIn: 200, fadeOut: 300 } });
    const { gainEvents } = await previewOf(v, 1, 3000);
    const tl = evaluateVoice(v, 1000, 3000);
    const delta = maxDelta(
      tl.startMs,
      tl.endMs,
      (ms) => paramAt(gainEvents, T0 + ms / 1000),
      (ms) => tl.gainAt(ms),
    );
    expect(delta).toBeLessThan(EPS);
  });

  it("warp 变速 + 包络：增益与速率两路都与导出端逐点一致", async () => {
    const v = voice({
      rate: {
        kind: "warp",
        points: [
          { atMs: 0, srcMs: 0 },
          { atMs: 400, srcMs: "end" },
        ],
      },
      gain: {
        value: 1,
        fadeIn: 100,
        envelope: {
          points: [
            { atMs: 100, value: 1 },
            { atMs: 300, value: 0.5 },
          ],
        },
      },
    });
    const { gainEvents, source } = await previewOf(v, 1, 1000);
    const tl = evaluateVoice(v, 1000, 1000);
    expect(tl.endMs).toBeCloseTo(400, 6);
    const gainDelta = maxDelta(
      tl.startMs,
      tl.endMs,
      (ms) => paramAt(gainEvents, T0 + ms / 1000),
      (ms) => tl.gainAt(ms),
    );
    const rateDelta = maxDelta(
      tl.startMs,
      tl.endMs,
      (ms) => paramAt(source.rate, T0 + ms / 1000),
      (ms) => tl.rateAt(ms),
    );
    expect(gainDelta).toBeLessThan(EPS);
    expect(rateDelta).toBeLessThan(EPS);
    // 同一张斜率表：2.5 倍速把 1000ms 的源压到 400ms
    expect(tl.rateAt(0)).toBeCloseTo(2.5, 6);
  });

  it("运行期 setGain 折进时间线：两端读同一组折点", async () => {
    const v = voice({
      ops: [{ kind: "gain", atMs: 400, value: 0.4, rampMs: 200 }],
      gain: { value: 1, fadeIn: 100 },
    });
    const { gainEvents } = await previewOf(v, 2, 3000);
    const tl = evaluateVoice(v, 2000, 3000);
    const delta = maxDelta(
      tl.startMs,
      tl.endMs,
      (ms) => paramAt(gainEvents, T0 + ms / 1000),
      (ms) => tl.gainAt(ms),
    );
    expect(delta).toBeLessThan(EPS);
  });

  it("stop 淡出：终点与淡出曲线两端一致", async () => {
    const v = voice({ ops: [{ kind: "stop", atMs: 600, fadeMs: 200 }] });
    const { gainEvents, source } = await previewOf(v, 2, 3000);
    const tl = evaluateVoice(v, 2000, 3000);
    expect(tl.endMs).toBeCloseTo(600, 6);
    const delta = maxDelta(
      tl.startMs,
      tl.endMs,
      (ms) => paramAt(gainEvents, T0 + ms / 1000),
      (ms) => tl.gainAt(ms),
    );
    expect(delta).toBeLessThan(EPS);
    // 显式收声：预览的 stop 落点与求值点给出的终点一致
    expect(source.stopAt).toBeCloseTo(T0 + tl.endMs / 1000, 6);
  });

  it("起点偏移与 loop 收尾：源起点、截断点由求值点统一给出", async () => {
    const v = voice({ startMs: 1200, loop: {} });
    const { source } = await previewOf(v, 1, 3000);
    const tl = evaluateVoice(v, 1000, 3000);
    expect(source.startAt).toBeCloseTo(T0 + 1200 / 1000, 6);
    expect(source.offset).toBeCloseTo(0, 6);
    // loop 源本身无限长：终点仍是总时间线尾（不是源播完）
    expect(source.stopAt).toBeCloseTo(T0 + tl.endMs / 1000, 6);
    expect(tl.endMs).toBeCloseTo(3000, 6);
  });

  it("程序化音源：ADSR × 音量 × 声音折点，与导出端逐点一致", async () => {
    const spec: SynthSpec = {
      wave: "sine",
      freq: 440,
      gain: 0.8,
      durationMs: 800,
      envelope: { attackMs: 100, decayMs: 200, sustain: 0.5, releaseMs: 150 },
    };
    const v = voice({ synth: spec, gain: { value: 0.9, fadeIn: 50 } });
    const { ampEvents, gainEvents } = await previewSynthOf(v, 2000);
    const tl = evaluateVoice(v, spec.durationMs, 2000);
    const delta = maxDelta(
      tl.startMs,
      tl.endMs,
      (ms) =>
        paramAt(ampEvents, T0 + ms / 1000) *
        paramAt(gainEvents, T0 + ms / 1000),
      (ms) =>
        synthEnvelopeAt(spec, ms - tl.startMs) *
        (spec.gain ?? 1) *
        tl.gainAt(ms),
    );
    expect(delta).toBeLessThan(EPS);
  });

  it("噪声波形：预览端缓冲与导出端逐样本同源，由声明的种子决定", async () => {
    // 常幅包络（振幅全由增益节点承担），两端剩下的就只有噪声序列本身
    const spec: SynthSpec = {
      wave: "noise",
      freq: 440,
      durationMs: 200,
      gain: 1,
      seed: 2024,
      envelope: { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 },
    };
    const buf = await previewNoiseOf(voice({ synth: spec }), 300);
    const pcm = renderSynth(spec, 48_000, 1);
    expect(buf.length).toBe(pcm.data.length);
    for (const i of [1, 1000, 4000, pcm.data.length - 1])
      expect(buf[i]).toBe(pcm.data[i]);

    // 换种子：预览与导出同时对同一份新序列取数
    const changed: SynthSpec = { ...spec, seed: 2025 };
    const other = await previewNoiseOf(voice({ synth: changed }), 300);
    const otherPcm = renderSynth(changed, 48_000, 1);
    for (const i of [1, 1000]) expect(other[i]).toBe(otherPcm.data[i]);
    expect(Array.from(other)).not.toEqual(Array.from(buf));
  });
});
