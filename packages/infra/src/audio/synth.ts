/**
 * 程序化音源：按 SynthSpec 确定性合成 PCM。
 * 同一份 spec + 同一声明布局 = 每次导出同样的样本；不使用 Math.random。
 */
import type { Ms, SynthSpec, Waveform } from "@lingfan-video/contracts";
import {
  DEFAULT_SYNTH_GAIN,
  DEFAULT_SYNTH_SEED,
} from "@lingfan-video/contracts";

export { DEFAULT_SYNTH_GAIN } from "@lingfan-video/contracts";

const TAU = Math.PI * 2;

/** xorshift32：确定性伪随机（noise 波形与混响 IR 用） */
export function seededRandom(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * 程序化音源的噪声种子：声明值优先，缺省取契约里的固定值（32 位无符号）。
 * 预览与导出都走这一处换算，同一份 spec 在两端得到同一串噪声。
 */
export function synthSeed(spec: SynthSpec): number {
  return (spec.seed ?? DEFAULT_SYNTH_SEED) >>> 0;
}

const DEFAULT_ENVELOPE = {
  attackMs: 5,
  decayMs: 30,
  sustain: 0.8,
  releaseMs: 80,
};

/** ADSR 幅度（0..1），入参为源内局部毫秒 */
export function synthEnvelopeAt(spec: SynthSpec, localMs: Ms): number {
  const env = spec.envelope ?? DEFAULT_ENVELOPE;
  const dur = spec.durationMs;
  const a = Math.max(0, Math.min(env.attackMs, dur));
  const d = Math.max(0, Math.min(env.decayMs, dur - a));
  const r = Math.max(0, Math.min(env.releaseMs, dur));
  const sustain = Math.max(0, Math.min(1, env.sustain));
  const releaseStart = Math.max(0, dur - r);
  if (localMs < a) return a <= 0 ? 1 : localMs / a;
  if (localMs < a + d)
    return d <= 0 ? 1 : 1 - (1 - sustain) * ((localMs - a) / d);
  if (localMs >= releaseStart && r > 0)
    return sustain * Math.max(0, (dur - localMs) / r);
  return sustain;
}

/** ADSR 折线（预览端排 AudioParam 用；与导出端同一组折点） */
export function synthEnvelopePoints(
  spec: SynthSpec,
): readonly { atMs: Ms; gain: number }[] {
  const env = spec.envelope ?? DEFAULT_ENVELOPE;
  const dur = spec.durationMs;
  const a = Math.max(0, Math.min(env.attackMs, dur));
  const d = Math.max(0, Math.min(env.decayMs, dur - a));
  const r = Math.max(0, Math.min(env.releaseMs, dur));
  const sustain = Math.max(0, Math.min(1, env.sustain));
  const pts: { atMs: Ms; gain: number }[] = [];
  pts.push({ atMs: 0, gain: a <= 0 ? 1 : 0 });
  if (a > 0) pts.push({ atMs: a, gain: 1 });
  if (d > 0) pts.push({ atMs: a + d, gain: sustain });
  const releaseStart = Math.max(0, dur - r);
  if (r > 0) {
    pts.push({ atMs: releaseStart, gain: sustain });
    pts.push({ atMs: dur, gain: 0 });
  } else {
    pts.push({ atMs: dur, gain: sustain });
  }
  return pts;
}

/**
 * ADSR 折线乘以音量：预览端把这条折线写进增益节点，导出端逐样本乘同一幅度，
 * 两端因此得到相同的振幅包络（波形本身各由振荡器/合成器产生）。
 */
export function synthAmpEnvelopePoints(
  spec: SynthSpec,
): readonly { atMs: Ms; gain: number }[] {
  const amp = Math.max(0, spec.gain ?? DEFAULT_SYNTH_GAIN);
  return synthEnvelopePoints(spec).map((p) => ({
    atMs: p.atMs,
    gain: p.gain * amp,
  }));
}

function waveSample(wave: Waveform, phase: number, rnd: () => number): number {
  switch (wave) {
    case "sine":
      return Math.sin(phase);
    case "square":
      return Math.sin(phase) >= 0 ? 1 : -1;
    case "saw": {
      const p = phase / TAU;
      return 2 * (p - Math.floor(p + 0.5));
    }
    case "triangle":
      return (2 / Math.PI) * Math.asin(Math.sin(phase));
    case "noise":
      return rnd() * 2 - 1;
  }
}

/** 合成的 PCM 结果（交错、按声明布局） */
export interface SynthPcm {
  readonly data: Float32Array;
  readonly channels: number;
  readonly sampleRate: number;
  readonly durationMs: Ms;
}

/** 确定性合成：返回交错 Float32（长度 = frames × channels） */
export function renderSynth(
  spec: SynthSpec,
  sampleRate: number,
  channels = 2,
): SynthPcm {
  const frames = Math.max(1, Math.round((spec.durationMs / 1000) * sampleRate));
  const data = new Float32Array(frames * channels);
  const rnd = seededRandom(synthSeed(spec));
  const detune = spec.detune ?? 0;
  const freq = spec.freq * Math.pow(2, detune / 1200);
  const gain = Math.max(0, spec.gain ?? DEFAULT_SYNTH_GAIN);
  const dt = (1 / sampleRate) * TAU * freq;
  let phase = 0;
  for (let f = 0; f < frames; f++) {
    const localMs = (f / sampleRate) * 1000;
    const amp = synthEnvelopeAt(spec, localMs) * gain;
    const v = waveSample(spec.wave, phase, rnd) * amp;
    phase += dt;
    if (phase > TAU) phase -= TAU;
    for (let c = 0; c < channels; c++) data[f * channels + c] = v;
  }
  return { data, channels, sampleRate, durationMs: spec.durationMs };
}
