/** 总线效果链（就地处理）：滤波、压缩、延迟与混响，全部逐样本且确定性。 */
import type {
  CompressorSpec,
  DelaySpec,
  FilterSpec,
  ReverbSpec,
} from "@lingfan-video/contracts";
import { SILENT, onePole } from "./dsp";

/** biquad 滤波（RBJ cookbook；就地处理） */
function filterInPlace(
  buf: Float32Array,
  spec: FilterSpec,
  sr: number,
  ch: number,
): void {
  const f = Math.max(10, Math.min(sr / 2 - 1, spec.frequency));
  const q = spec.q ?? Math.SQRT1_2;
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (spec.type === "lowpass") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (spec.type === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;
  for (let c = 0; c < ch; c++) {
    let z1 = 0;
    let z2 = 0;
    for (let fr = 0; fr < buf.length / ch; fr++) {
      const i = fr * ch + c;
      const x = buf[i]!;
      const y = nb0 * x + z1;
      z1 = nb1 * x - na1 * y + z2;
      z2 = nb2 * x - na2 * y;
      buf[i] = y;
    }
  }
}

/** 压缩器（就地；峰值检测 + 硬拐点）；env 平滑后直接换算增益 */
function compressorInPlace(
  buf: Float32Array,
  spec: CompressorSpec,
  sr: number,
  ch: number,
): void {
  const attack = onePole(spec.attackMs, sr);
  const release = onePole(spec.releaseMs, sr);
  const ratio = Math.max(1, spec.ratio);
  let env = 0;
  let reduction = 0;
  for (let fr = 0; fr < buf.length / ch; fr++) {
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const v = Math.abs(buf[fr * ch + c] ?? 0);
      if (v > peak) peak = v;
    }
    const coef = peak > env ? attack : release;
    env = coef * env + (1 - coef) * peak;
    const db = 20 * Math.log10(Math.max(env, SILENT));
    const over = db - spec.thresholdDb;
    const target = over > 0 ? -(over * (1 - 1 / ratio)) : 0;
    const smooth = target < reduction ? attack : release;
    reduction = smooth * reduction + (1 - smooth) * target;
    const g = 10 ** (reduction / 20);
    if (g === 1) continue;
    for (let c = 0; c < ch; c++) {
      const i = fr * ch + c;
      buf[i] = buf[i]! * g;
    }
  }
}

/** 延迟线（确定性）：逐声道环形缓冲 + 反馈，干湿混合 */
function delayInPlace(
  buf: Float32Array,
  spec: DelaySpec,
  sr: number,
  ch: number,
): void {
  const d = Math.max(1, Math.round((spec.delayMs * sr) / 1000));
  const fb = Math.max(0, Math.min(0.95, spec.feedback ?? 0.3));
  const mix = Math.max(0, Math.min(1, spec.mix ?? 0.5));
  const frames = Math.floor(buf.length / ch);
  // 每声道独立成线：共用一条线会让一端的湿声读到另一端的干声（预览端的 DelayNode 也不是这样）
  for (let c = 0; c < ch; c++) {
    const line = new Float32Array(d);
    let idx = 0;
    for (let f = 0; f < frames; f++) {
      const i = f * ch + c;
      const dry = buf[i]!;
      const wet = line[idx]!;
      line[idx] = dry + wet * fb;
      buf[i] = dry * (1 - mix) + wet * mix;
      idx = (idx + 1) % d;
    }
  }
}

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

/**
 * 简化 Freeverb（确定性）：8 comb 并联 + 4 allpass 串联，按 44.1k 基准调谐缩放。
 * 与预览端 ConvolverNode 的 IR 卷积不是同一算法：音色近似，时序一致。
 */
function reverbInPlace(
  buf: Float32Array,
  spec: ReverbSpec,
  sr: number,
  ch: number,
): void {
  const scale = sr / 44100;
  const room = Math.max(0, Math.min(1, spec.roomSize ?? 0.7));
  const damp = Math.max(0, Math.min(1, spec.damping ?? 0.4));
  const mix = Math.max(0, Math.min(1, spec.mix ?? 0.35));
  const feedback = room * 0.28 + 0.7;
  const damp1 = damp * 0.4;
  const damp2 = 1 - damp1;
  const frames = Math.floor(buf.length / ch);
  for (let c = 0; c < ch; c++) {
    const spread = c * STEREO_SPREAD;
    const combs = COMB_TUNING.map((t) => ({
      buf: new Float32Array(Math.max(1, Math.round((t + spread) * scale))),
      idx: 0,
      store: 0,
    }));
    const aps = ALLPASS_TUNING.map((t) => ({
      buf: new Float32Array(Math.max(1, Math.round((t + spread) * scale))),
      idx: 0,
    }));
    for (let f = 0; f < frames; f++) {
      const i = f * ch + c;
      const dry = buf[i]!;
      const input = dry * 0.015;
      let out = 0;
      for (const cb of combs) {
        const y = cb.buf[cb.idx]!;
        cb.store = y * damp2 + cb.store * damp1;
        cb.buf[cb.idx] = input + cb.store * feedback;
        cb.idx = (cb.idx + 1) % cb.buf.length;
        out += y;
      }
      for (const ap of aps) {
        const b = ap.buf[ap.idx]!;
        const y = -out + b;
        ap.buf[ap.idx] = out + b * 0.5;
        ap.idx = (ap.idx + 1) % ap.buf.length;
        out = y;
      }
      buf[i] = dry * (1 - mix) + out * mix;
    }
  }
}

export {
  ALLPASS_TUNING,
  COMB_TUNING,
  STEREO_SPREAD,
  compressorInPlace,
  delayInPlace,
  filterInPlace,
  reverbInPlace,
};
