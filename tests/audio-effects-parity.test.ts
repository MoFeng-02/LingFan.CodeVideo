/**
 * 双端音色与效果同源清点：同一条总线声明、同一份合成声明，在预览端（WebAudio 节点）
 * 与导出端（就地 DSP）分别落到什么节点/系数上。记录型 AudioContext 见 `tests/support/audio-harness.ts`。
 *
 * 这里区分三档，而不是笼统地「一致」：
 * - 可证同源：两端读同一份声明，残差只由浮点/量化决定（延迟的延时量与反馈、合成包络）；
 * - 算法不同但各自确定：混响（IR 卷积 vs 梳状-全通网络）、非正弦波形（带限 vs 朴素）；
 * - 语义不一致：程序化音源的声音速率在预览端没有落地（只改了音高、没有重采样）。
 */
import { describe, expect, it } from "vitest";
import type {
  AudioGraph,
  AudioProgram,
  AudioVoice,
  SynthSpec,
} from "@lingfan-video/contracts";
import { OfflineAudioMixer, WebAudioOutput } from "@lingfan-video/infra";
import { mixBusGraph } from "../packages/infra/src/audio/bus-mixer";
import { renderSynth } from "../packages/infra/src/audio/synth";
import {
  flush,
  makeHarness,
  type FakeAudioBuffer,
  type Harness,
  type ParamEvent,
} from "./support/audio-harness";

const SR = 48_000;
const TAU = Math.PI * 2;

function graphOf(
  buses: AudioGraph["buses"],
  extra?: Partial<AudioGraph>,
): AudioGraph {
  return { buses, sends: [], ducks: [], automation: [], ...extra };
}

async function previewBus(
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

function gainById(h: Harness, id: number) {
  const found = h.gains.find((g) => g.id === id);
  if (!found) throw new Error(`未找到增益节点 ${id}`);
  return found;
}

/** 定位延迟块：反馈增益既读延迟节点又送回延迟节点，湿声与干声在合并点汇合 */
function delayBlock(h: Harness) {
  const delay = h.delays[0];
  if (!delay) throw new Error("预览端没有建延迟节点");
  const out = h.outputsOf(delay.id).filter((id) => h.kindOf(id) === "gain");
  const fbId = out.find((id) => h.outputsOf(id).includes(delay.id));
  const wetId = out.find((id) => id !== fbId);
  if (fbId === undefined || wetId === undefined)
    throw new Error("延迟块缺少反馈或湿声增益");
  const mergeId = h.outputsOf(wetId).find((id) => h.kindOf(id) === "gain");
  if (mergeId === undefined) throw new Error("延迟块缺少汇合点");
  const dryId = h
    .inputsOf(mergeId)
    .find((id) => h.kindOf(id) === "gain" && id !== wetId);
  if (dryId === undefined) throw new Error("延迟块缺少干声增益");
  return {
    delay,
    fb: gainById(h, fbId),
    wet: gainById(h, wetId),
    dry: gainById(h, dryId),
    merge: gainById(h, mergeId),
  };
}

/** 定位混响块：卷积节点只接湿声，干声与湿声在合并点汇合 */
function reverbBlock(h: Harness) {
  const conv = h.convolvers[0];
  if (!conv) throw new Error("预览端没有建卷积节点");
  const wetId = h.outputsOf(conv.id).find((id) => h.kindOf(id) === "gain");
  const mergeId =
    wetId === undefined
      ? undefined
      : h.outputsOf(wetId).find((id) => h.kindOf(id) === "gain");
  if (wetId === undefined || mergeId === undefined)
    throw new Error("混响块缺少湿声或汇合点");
  const dryId = h
    .inputsOf(mergeId)
    .find((id) => h.kindOf(id) === "gain" && id !== wetId);
  if (dryId === undefined) throw new Error("混响块缺少干声增益");
  return {
    conv,
    wet: gainById(h, wetId),
    dry: gainById(h, dryId),
    merge: gainById(h, mergeId),
  };
}

/**
 * 导出端：把单个冲激铺进总线，取回总线输出。
 * `layoutVoice` 只负责往输入里放一个冲激，其余交给被测的总线图，效果的时序因此可以单独观察。
 */
function renderImpulse(
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
  return mixBusGraph({
    sampleRate: SR,
    channels: 2,
    frames,
    durationMs: (frames / SR) * 1000,
    voices: [voice],
    graph,
    layoutVoice: (_voice, target) => {
      target[0] = amp;
      target[1] = amp;
    },
  });
}

/** 左声道幅值最大处所在样本（用于量延迟） */
function peakIndex(data: Float32Array): number {
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

function energy(
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
function toneMagnitude(
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

function zeroCrossRate(
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

function lastEvent(events: readonly ParamEvent[]): ParamEvent | undefined {
  return events[events.length - 1];
}

function synthVoice(spec: SynthSpec, extra?: Partial<AudioVoice>): AudioVoice {
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

describe("效果同源：延迟", () => {
  it("延时量、反馈与干湿系数在两端读同一份声明", async () => {
    const graph = graphOf([
      {
        id: "fx",
        effects: [{ kind: "delay", delayMs: 180, feedback: 0.35, mix: 0.5 }],
      },
    ]);
    const h = await previewBus(graph);
    const block = delayBlock(h);
    expect(block.delay.maxDelayTime).toBe(5);
    expect(block.delay.delayTime.value).toBeCloseTo(0.18, 9);
    expect(block.fb.gain.value).toBeCloseTo(0.35, 9);
    expect(block.wet.gain.value).toBeCloseTo(0.5, 9);
    expect(block.dry.gain.value).toBeCloseTo(0.5, 9);

    // 缺省系数与导出端同一组缺省：feedback 0.3、mix 0.5
    const defaults = await previewBus(
      graphOf([{ id: "fx", effects: [{ kind: "delay", delayMs: 120 }] }]),
    );
    const db = delayBlock(defaults);
    expect(db.fb.gain.value).toBeCloseTo(0.3, 9);
    expect(db.wet.gain.value).toBeCloseTo(0.5, 9);

    // 两端各自把越界声明夹到同一区间
    const clamped = await previewBus(
      graphOf([
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs: 90, feedback: 2, mix: -1 }],
        },
      ]),
    );
    const cb = delayBlock(clamped);
    expect(cb.fb.gain.value).toBeCloseTo(0.95, 9);
    expect(cb.wet.gain.value).toBeCloseTo(0, 9);
    expect(cb.dry.gain.value).toBeCloseTo(1, 9);
  });

  it("延迟时序：预览的延时量与导出的环形缓冲同一处落点", async () => {
    for (const delayMs of [180, 180.3, 7.77, 1, 0.5]) {
      const graph = graphOf([
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs, feedback: 0, mix: 1 }],
        },
      ]);
      const h = await previewBus(graph);
      const previewSamples = delayBlock(h).delay.delayTime.value * SR;
      const out = renderImpulse(graph);
      const exportSamples = peakIndex(out);
      // 导出端按采样取整，且至少留一个采样；预览端按秒给出精确延时
      expect(exportSamples).toBe(
        Math.max(1, Math.round((delayMs / 1000) * SR)),
      );
      if (delayMs >= 1) {
        // 量化残差不超过半个采样：两端指向同一个毫秒值
        expect(Math.abs(previewSamples - exportSamples)).toBeLessThanOrEqual(
          0.5,
        );
      } else {
        // 亚毫秒声明：预览端有 1ms 的下限，导出端只保留一个采样起步
        expect(previewSamples).toBeCloseTo(48, 9);
        expect(exportSamples).toBe(24);
        expect(Math.abs(previewSamples - exportSamples)).toBeCloseTo(24, 6);
      }
    }
  });

  it("反馈：两端的回声逐级衰减由同一个系数决定", async () => {
    const graph = graphOf([
      {
        id: "fx",
        effects: [{ kind: "delay", delayMs: 10, feedback: 0.35, mix: 1 }],
      },
    ]);
    const h = await previewBus(graph);
    expect(delayBlock(h).fb.gain.value).toBeCloseTo(0.35, 9);

    const out = renderImpulse(graph, { frames: SR / 4 });
    const step = Math.round(0.01 * SR);
    let previous = 0;
    for (let tap = 1; tap <= 4; tap++) {
      const value = Math.abs(out[step * tap * 2]!);
      // 两声道各走各的延迟线：右声道与左声道逐样本相同，不得读到对侧样本
      expect(out[step * tap * 2 + 1]!).toBe(out[step * tap * 2]!);
      if (tap === 1) expect(value).toBeCloseTo(1, 5);
      else expect(value).toBeCloseTo(previous * 0.35, 5);
      previous = value;
    }
    // 干声被 mix=1 完全替换：冲激时刻本身没有输出
    expect(Math.abs(out[0]!)).toBeLessThan(1e-6);
  });
});

describe("效果同源：混响", () => {
  it("两条 DSP 路径：预览是 IR 卷积，导出是梳状-全通网络，各自确定", async () => {
    const graph = graphOf([
      { id: "fx", effects: [{ kind: "reverb", roomSize: 0.7, mix: 0.8 }] },
    ]);
    const h = await previewBus(graph);
    const ir = reverbBlock(h).conv.buffer;
    if (!ir) throw new Error("预览端没有给卷积节点装 IR");
    // IR 长度由声明决定：0.6s 底 + roomSize × 1.6s
    expect(ir.length).toBe(Math.round((0.6 + 0.7 * 1.6) * SR));
    expect(ir.numberOfChannels).toBe(2);
    // 同一声明两次建图逐样本相同：预览端的随机尾巴是确定性种子给的
    const again = await previewBus(graph);
    const ir2 = reverbBlock(again).conv.buffer as FakeAudioBuffer;
    expect(Array.from(ir2.getChannelData(0))).toEqual(
      Array.from(ir.getChannelData(0)),
    );

    // 导出端同样确定，且确有尾音
    const a = renderImpulse(graph, { frames: SR * 2 });
    const b = renderImpulse(graph, { frames: SR * 2 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(energy(a, 400, 900)).toBeGreaterThan(0.5);
  });

  it("同一声明在两端引起同向变化：房间越大，尾音越长", async () => {
    const lengths: number[] = [];
    const tails: number[] = [];
    for (const roomSize of [0.2, 0.85]) {
      const graph = graphOf([
        { id: "fx", effects: [{ kind: "reverb", roomSize, mix: 1 }] },
      ]);
      const h = await previewBus(graph);
      lengths.push(reverbBlock(h).conv.buffer!.length);
      const out = renderImpulse(graph, { frames: SR * 2 });
      tails.push(energy(out, 700, 900));
    }
    expect(lengths[1]!).toBeGreaterThan(lengths[0]!);
    expect(tails[1]!).toBeGreaterThan(tails[0]!);
  });
});

describe("音色同源：波形与速率", () => {
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

  it("声音速率：预览端不读它，导出端按它重采样——时长同源、音高不同", async () => {
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

/** 排程单个程序化声音并抓回它在预览端建的振荡器 */
async function previewSynthVoice(voice: AudioVoice, durationMs: number) {
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

describe("效果同源：链序", () => {
  it("预览按声明顺序串联，干湿并联在链尾，最后才进总线增益与声像", async () => {
    const graph = graphOf([
      {
        id: "music",
        parent: "fx",
        gain: 0.8,
        pan: -0.5,
        effects: [
          { kind: "filter", type: "highpass", frequency: 200, q: 0.9 },
          {
            kind: "compressor",
            thresholdDb: -20,
            ratio: 4,
            attackMs: 3,
            releaseMs: 120,
            kneeDb: 6,
          },
          { kind: "delay", delayMs: 60, feedback: 0.2, mix: 0.4 },
          { kind: "reverb", roomSize: 0.5, mix: 0.3 },
        ],
      },
      { id: "fx" },
    ]);
    const h = await previewBus(graph);
    const filter = h.biquads[0]!;
    const inputId = h.inputsOf(filter.id).find((id) => h.kindOf(id) === "gain");
    if (inputId === undefined) throw new Error("滤波器没有接到总线入口");
    const comp = h.compressors[0]!;
    const delay = h.delays[0]!;
    const reverb = h.convolvers[0]!;
    // 声明顺序即拓扑顺序
    expect(h.outputsOf(inputId)).toContain(filter.id);
    expect(h.outputsOf(filter.id)).toContain(comp.id);
    expect(h.outputsOf(comp.id)).toContain(delay.id);
    const delayOut = delayBlock(h);
    expect(h.outputsOf(delayOut.merge.id)).toContain(reverb.id);
    // 效果链之后才是总线增益与声像，再汇入父总线
    const busGain = h
      .outputsOf(reverbBlock(h).merge.id)
      .find((id) => h.kindOf(id) === "gain")!;
    const panner = h
      .outputsOf(busGain)
      .find((id) => h.kindOf(id) === "panner")!;
    expect(h.inputsOf(panner)).toContain(busGain);
    // 子总线：声像 → 父总线入口；父总线声像 → master 入口 → master 增益 → 扬声器
    const parentInputId = h
      .outputsOf(panner)
      .find((id) => h.kindOf(id) === "gain");
    if (parentInputId === undefined) throw new Error("子总线没有接入父总线");
    const masterGainId = h.gains.find((g) =>
      h.outputsOf(g.id).includes(-1),
    )!.id;
    const masterInputId = h
      .inputsOf(masterGainId)
      .find((id) => h.kindOf(id) === "gain")!;
    expect(h.inputsOf(masterInputId)).toHaveLength(1);
    const fxPanner = h.panners.find((p) => p.id !== panner);
    if (!fxPanner) throw new Error("父总线没有声像节点");
    expect(h.inputsOf(masterInputId)).toContain(fxPanner.id);

    // 参数映射：类型、频率、缺省 Q 与声明一致；压缩器把毫秒换算成秒
    expect(filter.type).toBe("highpass");
    expect(filter.frequency.value).toBe(200);
    expect(filter.Q.value).toBe(0.9);
    expect(comp.threshold.value).toBe(-20);
    expect(comp.ratio.value).toBe(4);
    expect(comp.attack.value).toBeCloseTo(0.003, 9);
    expect(comp.release.value).toBeCloseTo(0.12, 9);
    expect(comp.knee.value).toBe(6);
    expect(gainById(h, busGain).gain.value).toBeCloseTo(0.8, 9);
  });
});
