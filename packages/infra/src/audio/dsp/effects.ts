/**
 * 总线效果单元（块处理）：内部状态跨块保留，逐样本运算与整段实现一致。
 * 内核不碰 WebAudio——主线程、AudioWorklet、Node 三处可用同一份实现。
 */
import type {
  CompressorSpec,
  DelaySpec,
  EffectSpec,
  FilterSpec,
  ReverbSpec,
} from "@lingfan-video/contracts";
import { SILENT, onePole } from "./math";

/** 一个效果单元：就地把一个块（frames × channels 交错样本）处理完 */
export interface EffectUnit {
  process(buf: Float32Array, frames: number): void;
}

/** RBJ biquad：系数建时算一次，每声道两份状态 */
class BiquadUnit implements EffectUnit {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly z1: Float32Array;
  private readonly z2: Float32Array;

  constructor(
    spec: FilterSpec,
    sr: number,
    private readonly ch: number,
  ) {
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
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    this.z1 = new Float32Array(ch);
    this.z2 = new Float32Array(ch);
  }

  process(buf: Float32Array, frames: number): void {
    for (let c = 0; c < this.ch; c++) {
      let z1 = this.z1[c]!;
      let z2 = this.z2[c]!;
      for (let fr = 0; fr < frames; fr++) {
        const i = fr * this.ch + c;
        const x = buf[i]!;
        const y = this.b0 * x + z1;
        z1 = this.b1 * x - this.a1 * y + z2;
        z2 = this.b2 * x - this.a2 * y;
        buf[i] = y;
      }
      this.z1[c] = z1;
      this.z2[c] = z2;
    }
  }
}

/** 压缩器：峰值检测 + 硬拐点，env 与 reduction 两个状态 */
class CompressorUnit implements EffectUnit {
  private readonly attack: number;
  private readonly release: number;
  private readonly ratio: number;
  private env = 0;
  private reduction = 0;

  constructor(
    private readonly spec: CompressorSpec,
    sr: number,
    private readonly ch: number,
  ) {
    this.attack = onePole(spec.attackMs, sr);
    this.release = onePole(spec.releaseMs, sr);
    this.ratio = Math.max(1, spec.ratio);
  }

  process(buf: Float32Array, frames: number): void {
    for (let fr = 0; fr < frames; fr++) {
      let peak = 0;
      for (let c = 0; c < this.ch; c++) {
        const v = Math.abs(buf[fr * this.ch + c] ?? 0);
        if (v > peak) peak = v;
      }
      const coef = peak > this.env ? this.attack : this.release;
      this.env = coef * this.env + (1 - coef) * peak;
      const db = 20 * Math.log10(Math.max(this.env, SILENT));
      const over = db - this.spec.thresholdDb;
      const target = over > 0 ? -(over * (1 - 1 / this.ratio)) : 0;
      const smooth = target < this.reduction ? this.attack : this.release;
      this.reduction = smooth * this.reduction + (1 - smooth) * target;
      const g = 10 ** (this.reduction / 20);
      if (g === 1) continue;
      for (let c = 0; c < this.ch; c++) {
        const i = fr * this.ch + c;
        buf[i] = buf[i]! * g;
      }
    }
  }
}

/** 延迟线：每声道独立环形缓冲 + 反馈，干湿混合 */
class DelayUnit implements EffectUnit {
  private readonly d: number;
  private readonly fb: number;
  private readonly mix: number;
  private readonly lines: Float32Array[];
  private readonly idx: Uint32Array;

  constructor(
    spec: DelaySpec,
    sr: number,
    private readonly ch: number,
  ) {
    this.d = Math.max(1, Math.round((spec.delayMs * sr) / 1000));
    this.fb = Math.max(0, Math.min(0.95, spec.feedback ?? 0.3));
    this.mix = Math.max(0, Math.min(1, spec.mix ?? 0.5));
    this.lines = Array.from({ length: ch }, () => new Float32Array(this.d));
    this.idx = new Uint32Array(ch);
  }

  process(buf: Float32Array, frames: number): void {
    for (let c = 0; c < this.ch; c++) {
      const line = this.lines[c]!;
      let idx = this.idx[c]!;
      for (let fr = 0; fr < frames; fr++) {
        const i = fr * this.ch + c;
        const dry = buf[i]!;
        const wet = line[idx]!;
        line[idx] = dry + wet * this.fb;
        buf[i] = dry * (1 - this.mix) + wet * this.mix;
        idx = (idx + 1) % this.d;
      }
      this.idx[c] = idx;
    }
  }
}

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

interface CombState {
  buf: Float32Array;
  idx: number;
  store: number;
}

interface AllpassState {
  buf: Float32Array;
  idx: number;
}

/** 简化 Freeverb：8 comb 并联 + 4 allpass 串联，按 44.1k 基准调谐缩放 */
class ReverbUnit implements EffectUnit {
  private readonly mix: number;
  private readonly feedback: number;
  private readonly damp1: number;
  private readonly damp2: number;
  private readonly combs: CombState[][];
  private readonly aps: AllpassState[][];

  constructor(
    spec: ReverbSpec,
    sr: number,
    private readonly ch: number,
  ) {
    const scale = sr / 44100;
    const room = Math.max(0, Math.min(1, spec.roomSize ?? 0.7));
    const damp = Math.max(0, Math.min(1, spec.damping ?? 0.4));
    this.mix = Math.max(0, Math.min(1, spec.mix ?? 0.35));
    this.feedback = room * 0.28 + 0.7;
    this.damp1 = damp * 0.4;
    this.damp2 = 1 - this.damp1;
    this.combs = [];
    this.aps = [];
    for (let c = 0; c < ch; c++) {
      const spread = c * STEREO_SPREAD;
      this.combs.push(
        COMB_TUNING.map((t) => ({
          buf: new Float32Array(Math.max(1, Math.round((t + spread) * scale))),
          idx: 0,
          store: 0,
        })),
      );
      this.aps.push(
        ALLPASS_TUNING.map((t) => ({
          buf: new Float32Array(Math.max(1, Math.round((t + spread) * scale))),
          idx: 0,
        })),
      );
    }
  }

  process(buf: Float32Array, frames: number): void {
    for (let c = 0; c < this.ch; c++) {
      const combs = this.combs[c]!;
      const aps = this.aps[c]!;
      for (let fr = 0; fr < frames; fr++) {
        const i = fr * this.ch + c;
        const dry = buf[i]!;
        const input = dry * 0.015;
        let out = 0;
        for (const cb of combs) {
          const y = cb.buf[cb.idx]!;
          cb.store = y * this.damp2 + cb.store * this.damp1;
          cb.buf[cb.idx] = input + cb.store * this.feedback;
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
        buf[i] = dry * (1 - this.mix) + out * this.mix;
      }
    }
  }
}

/** 按声明顺序把效果规格实例化成块处理单元 */
function createEffectUnits(
  specs: readonly EffectSpec[] | undefined,
  sr: number,
  ch: number,
): EffectUnit[] {
  const units: EffectUnit[] = [];
  for (const eff of specs ?? []) {
    if (eff.kind === "filter") units.push(new BiquadUnit(eff, sr, ch));
    else if (eff.kind === "compressor")
      units.push(new CompressorUnit(eff, sr, ch));
    else if (eff.kind === "delay") units.push(new DelayUnit(eff, sr, ch));
    else units.push(new ReverbUnit(eff, sr, ch));
  }
  return units;
}

export { ALLPASS_TUNING, COMB_TUNING, STEREO_SPREAD, createEffectUnits };
