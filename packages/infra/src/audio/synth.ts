/**
 * 程序化音源：按 SynthSpec 确定性合成 PCM。
 *
 * 同一份 spec + 同一声明布局 = 每次出片同样的样本；不使用 Math.random，
 * noise 波形的伪随机序列由种子决定。本模块不碰 WebAudio，导出端与预览端都能直接调用。
 */
import type { Ms, SynthSpec, Waveform } from "@lingfan-video/contracts";
import {
  DEFAULT_SYNTH_GAIN,
  DEFAULT_SYNTH_SEED,
} from "@lingfan-video/contracts";

export { DEFAULT_SYNTH_GAIN } from "@lingfan-video/contracts";

/** 一个周期的相位跨度（2π） */
const TAU = Math.PI * 2;

/**
 * xorshift32：确定性伪随机数生成器（noise 波形用）。
 *
 * 同一 seed 恒得同一序列，因此同一 spec 的合成结果可复现；不用于任何安全用途。
 * 实现细节：状态强制转 32 位无符号，seed 为 0 时替换为 1（xorshift 不能从 0 起步）。
 *
 * @param seed 32 位种子（缺省 0x9e3779b9）；按 `>>> 0` 取无符号
 * @returns 生成函数：每次调用推进一次状态并返回 [0, 1) 的浮点数
 */
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
 *
 * 预览与出片都走这一处换算，同一份 spec 在两端得到同一串噪声。
 *
 * @param spec 音源声明（`seed` 可缺省）
 * @returns 32 位无符号种子
 */
export function synthSeed(spec: SynthSpec): number {
  return (spec.seed ?? DEFAULT_SYNTH_SEED) >>> 0;
}

/** 缺省 ADSR（时间毫秒、sustain 为 0..1 的线性比例） */
const DEFAULT_ENVELOPE = {
  attackMs: 5,
  decayMs: 30,
  sustain: 0.8,
  releaseMs: 80,
};

/**
 * ADSR 幅度（0..1），入参为源内局部毫秒。
 *
 * 段定义：0..attack 线性升到 1；attack..attack+decay 线性降到 sustain；
 * 之后保持 sustain，直到 releaseStart（= durationMs - releaseMs）开始线性降到 0。
 * 各段时长先钳到 [0, durationMs]（decay 还受 attack 之后的剩余时长约束），
 * sustain 钳到 0..1，因此极短时长也能得到定义良好的曲线。
 *
 * @param spec 音源声明（`envelope` 缺省见 `DEFAULT_ENVELOPE`）
 * @param localMs 源内局部时间（毫秒，0 = 声音起点；超出 durationMs 时按末段处理）
 * @returns 该时刻的幅度乘子（0..1）
 */
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

/**
 * ADSR 折线（预览端排 AudioParam 用；与出片端同一组折点）。
 *
 * 折点按 atMs 递增，终点固定落在 durationMs（带 release 时归零，否则停在 sustain）。
 * 起点是 0 时刻（attack 为 0 时直接为 1），用于预览端的线性斜坡排布。
 *
 * @param spec 音源声明（`envelope` 缺省见 `DEFAULT_ENVELOPE`）
 * @returns 折点数组：atMs 为源内局部毫秒，gain 为 0..1 的幅度
 */
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
 * ADSR 折线乘以音量：预览端把这条折线写进增益节点，出片端逐样本乘同一幅度，
 * 两端因此得到相同的振幅包络（波形本身各由振荡器/合成器产生）。
 *
 * 音量取 `spec.gain`（缺省 `DEFAULT_SYNTH_GAIN`），负值按 0 处理。
 *
 * @param spec 音源声明
 * @returns 折点数组（与 `synthEnvelopePoints` 同形，gain 已乘音量）
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

/**
 * 单个样本的波形值（相位决定；noise 波形每次调用推进一次随机序列）。
 *
 * 四种周期波形都以 sin 为基准出发（square 取符号、saw 为 2×(p−floor(p+0.5))、
 * triangle 为 (2/π)·asin(sin)），因此相位跨度始终是 2π。
 *
 * @param wave 波形
 * @param phase 相位（弧度，0..2π 循环）
 * @param rnd 随机源（仅 noise 波形消费）
 * @returns 波形值（约 -1..1）
 */
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
  /** 交错样本：长度 = frames × channels；每帧各声道同值（振荡器不分声道） */
  readonly data: Float32Array;
  /** 声道数（调用方要求的布局，缺省 2） */
  readonly channels: number;
  /** 合成所用采样率（Hz） */
  readonly sampleRate: number;
  /** 声明时长（毫秒）；样本帧数按它四舍五入 */
  readonly durationMs: Ms;
}

/**
 * 确定性合成：返回交错 Float32（长度 = frames × channels）。
 *
 * 帧数 = round(durationMs / 1000 × sampleRate)（至少 1）；detune 以音分换算成
 * 频率倍率 2^(detune/1200)；每帧取一次噪声，各声道拿到同一个样本（单声道噪声居中）。
 * 相位每样本只回卷一次，频率接近或超过采样率时相位数值会持续增长（精度下降）；
 * 常规音源频率下不受影响。同 spec + 同参数的结果逐样本一致。
 *
 * @param spec 音源声明：波形、频率（Hz）、detune（音分，缺省 0）、ADSR、时长、种子、音量
 * @param sampleRate 输出采样率（Hz，须 > 0）
 * @param channels 声道数（缺省 2，须 ≥ 1）
 * @returns 合成结果（含交错样本与布局元数据）
 */
export function renderSynth(
  spec: SynthSpec,
  sampleRate: number,
  channels = 2,
): SynthPcm {
  /** 输出总帧数（至少 1） */
  const frames = Math.max(1, Math.round((spec.durationMs / 1000) * sampleRate));
  const data = new Float32Array(frames * channels);
  const rnd = seededRandom(synthSeed(spec));
  /** detune（音分）转成的频率倍率 */
  const detune = spec.detune ?? 0;
  /** 实际振荡频率（Hz） */
  const freq = spec.freq * Math.pow(2, detune / 1200);
  const gain = Math.max(0, spec.gain ?? DEFAULT_SYNTH_GAIN);
  /** 每样本的相位增量（弧度） */
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
