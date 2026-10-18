/**
 * 总线效果单元（块处理）：内部状态跨块保留，逐样本运算与整段实现一致。
 *
 * 内核不碰 WebAudio——主线程、AudioWorklet、Node 三处可用同一份实现。
 * 约定：效果单元按声明顺序串联，每个单元就地改写交错缓冲；`frames` 是帧数，
 * 交错步长由单元构造时给出的声道数决定。
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
  /**
   * 就地处理一个块：改写 buf 的前 frames × channels 个样本。
   *
   * 只处理传入的帧数，不假设块尺寸；内部状态（滤波器记忆、延迟线、包络）跨块保留，
   * 因此块边界不影响结果，但同一单元不能被两个块处理流并发复用。
   *
   * @param buf 交错样本缓冲（就地修改，长度 ≥ frames × 声道数）
   * @param frames 本块帧数（≥ 1）
   */
  process(buf: Float32Array, frames: number): void;
}

/**
 * RBJ biquad 滤波器（lowpass / highpass / bandpass 共用一套直接 II 型转置结构）。
 *
 * 系数在构造时算一次，之后只按帧递推；每个声道各有一份记忆（z1/z2），
 * 所以同一单元的多声道状态互不串扰。截止/中心频率钳在 [10, sr/2 - 1] Hz，
 * 超出奈奎斯特频率时按上限处理。
 */
class BiquadUnit implements EffectUnit {
  /** 归一化后的前馈系数 */
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  /** 归一化后的反馈系数 */
  private readonly a1: number;
  private readonly a2: number;
  /** 每声道两份状态记忆（直接 II 型转置） */
  private readonly z1: Float32Array;
  private readonly z2: Float32Array;

  /**
   * @param spec 滤波器规格：类型、频率（Hz）、Q（缺省 1/√2 ≈ 0.707）
   * @param sr 采样率（Hz），决定频率钳制上限与系数
   * @param ch 声道数
   */
  constructor(
    spec: FilterSpec,
    sr: number,
    private readonly ch: number,
  ) {
    /** 钳制后的截止/中心频率（Hz） */
    const f = Math.max(10, Math.min(sr / 2 - 1, spec.frequency));
    /** 品质因数（缺省 ~0.707，即无谐振的巴特沃斯响应） */
    const q = spec.q ?? Math.SQRT1_2;
    const w0 = (2 * Math.PI * f) / sr;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    /** RBJ 带宽项，Q 越小衰减越宽 */
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

  /** 逐声道递推滤波（每个声道独立状态，就地写回） */
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

/**
 * 压缩器：峰值检测 + 硬拐点，env 与 reduction 两个状态。
 *
 * 超过 thresholdDb 的部分按 ratio 压缩（硬拐点，不做 kneeDb 软过渡）；
 * 压缩量的增减各用一阶平滑（加深走 attack，恢复走 release）。
 */
class CompressorUnit implements EffectUnit {
  /** attack / release 的每样本保留比例 */
  private readonly attack: number;
  private readonly release: number;
  /** 压缩比（≥ 1） */
  private readonly ratio: number;
  /** 峰值包络（线性幅度） */
  private env = 0;
  /** 当前增益变化量（dB，≤ 0） */
  private reduction = 0;

  /**
   * @param spec 压缩器规格：阈值（dBFS）、压缩比、attack/release（毫秒）
   * @param sr 采样率（Hz）
   * @param ch 声道数（用多声道峰值做联动检测）
   */
  constructor(
    private readonly spec: CompressorSpec,
    sr: number,
    private readonly ch: number,
  ) {
    this.attack = onePole(spec.attackMs, sr);
    this.release = onePole(spec.releaseMs, sr);
    this.ratio = Math.max(1, spec.ratio);
  }

  /** 逐帧联动压缩：所有声道共用同一个乘子 */
  process(buf: Float32Array, frames: number): void {
    for (let fr = 0; fr < frames; fr++) {
      /** 本帧各声道的峰值（线性幅度） */
      let peak = 0;
      for (let c = 0; c < this.ch; c++) {
        const v = Math.abs(buf[fr * this.ch + c] ?? 0);
        if (v > peak) peak = v;
      }
      /** 包络跟随方向：上升走 attack，下降走 release */
      const coef = peak > this.env ? this.attack : this.release;
      this.env = coef * this.env + (1 - coef) * peak;
      const db = 20 * Math.log10(Math.max(this.env, SILENT));
      const over = db - this.spec.thresholdDb;
      /** 目标压缩量（dB，≤ 0）：超出阈值的部分按压缩比折算 */
      const target = over > 0 ? -(over * (1 - 1 / this.ratio)) : 0;
      /** 压缩量本身的平滑系数（压得更狠时走 attack） */
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

/**
 * 延迟线：每声道独立环形缓冲 + 反馈，干湿混合。
 *
 * 延迟帧数由毫秒换算（至少 1 帧）；反馈钳在 0..0.95 防止自激；mix 是湿声比例。
 */
class DelayUnit implements EffectUnit {
  /** 延迟长度（帧，≥ 1） */
  private readonly d: number;
  /** 反馈量（0..0.95） */
  private readonly fb: number;
  /** 湿声比例（0..1） */
  private readonly mix: number;
  /** 每声道的环形缓冲 */
  private readonly lines: Float32Array[];
  /** 每声道的写指针（帧） */
  private readonly idx: Uint32Array;

  /**
   * @param spec 延迟规格：延迟毫秒（> 0）、反馈（缺省 0.3）、湿声比例（缺省 0.5）
   * @param sr 采样率（Hz），用于毫秒 → 帧
   * @param ch 声道数
   */
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

  /** 逐声道读写环形缓冲，就地写成干湿混合后的样本 */
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

/** comb 延迟长度（帧，按 44.1kHz 基准；实际长度按输出采样率缩放） */
const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
/** allpass 延迟长度（帧，同样按 44.1kHz 基准缩放） */
const ALLPASS_TUNING = [556, 441, 341, 225];
/** 相邻声道之间的延迟展开（帧），让多个 comb/allpass 在立体声上错开 */
const STEREO_SPREAD = 23;

/** 一条 comb 滤波器的状态：环形缓冲、写指针与阻尼记忆 */
interface CombState {
  /** 环形缓冲（长度与延迟帧数一致） */
  buf: Float32Array;
  /** 写指针（帧） */
  idx: number;
  /** 阻尼低通记忆（线性幅度） */
  store: number;
}

/** 一条 allpass 滤波器的状态：环形缓冲与写指针 */
interface AllpassState {
  /** 环形缓冲（长度与延迟帧数一致） */
  buf: Float32Array;
  /** 写指针（帧） */
  idx: number;
}

/**
 * 简化 Freeverb：8 comb 并联 + 4 allpass 串联，按 44.1k 基准调谐缩放。
 *
 * 每个声道用同一组调谐但按 `STEREO_SPREAD` 逐声道错开延迟，形成立体声宽度；
 * 干湿比例由 mix 控制（缺省 0.35），输出不做额外增益补偿。
 */
class ReverbUnit implements EffectUnit {
  /** 湿声比例（0..1） */
  private readonly mix: number;
  /** comb 反馈量（由 roomSize 映射） */
  private readonly feedback: number;
  /** 阻尼低通的两个系数（damp1 + damp2 = 1） */
  private readonly damp1: number;
  private readonly damp2: number;
  /** 每声道一组 comb 状态 */
  private readonly combs: CombState[][];
  /** 每声道一组 allpass 状态 */
  private readonly aps: AllpassState[][];

  /**
   * @param spec 混响规格：房间大小（缺省 0.7）、阻尼（缺省 0.4）、湿声比例（缺省 0.35）
   * @param sr 采样率（Hz），各处延迟按 sr/44100 缩放
   * @param ch 声道数
   */
  constructor(
    spec: ReverbSpec,
    sr: number,
    private readonly ch: number,
  ) {
    /** 调谐表相对 44.1kHz 的缩放系数 */
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
      /** 本声道的延迟展开量（帧） */
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

  /** 逐声道：8 路 comb 并联求湿声，再串 4 级 allpass，最后与干声混合 */
  process(buf: Float32Array, frames: number): void {
    for (let c = 0; c < this.ch; c++) {
      const combs = this.combs[c]!;
      const aps = this.aps[c]!;
      for (let fr = 0; fr < frames; fr++) {
        const i = fr * this.ch + c;
        const dry = buf[i]!;
        /** 湿声支路输入（固定 0.015 的输入衰减） */
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

/**
 * 按声明顺序把效果规格实例化成块处理单元。
 *
 * 顺序即信号链顺序（例如「先滤波再混响」与「先混响再滤波」结果不同）；
 * 规格为空/未给出时返回空链。
 *
 * @param specs 总线声明的效果链；undefined 视为无效果
 * @param sr 采样率（Hz），传给每个单元
 * @param ch 声道数，决定交错步长与单元状态数量
 * @returns 可依次调用的块处理单元数组
 */
function createEffectUnits(
  specs: readonly EffectSpec[] | undefined,
  sr: number,
  ch: number,
): EffectUnit[] {
  /** 实例化后的效果链（与声明同序） */
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
