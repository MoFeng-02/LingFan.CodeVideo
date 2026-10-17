import type { Ms } from "../shared/units";
import type { BusId } from "./graph";

/** 振荡器波形（noise = 确定性伪随机，同一份程序每次导出同一样本） */
export type Waveform = "sine" | "square" | "saw" | "triangle" | "noise";

/**
 * 噪声波形的缺省种子。取值与历史输出一致：不声明 seed 的程序保持逐样本不变。
 * 种子在两端共用同一套伪随机序列，因此同 seed + 同采样率 = 同一样本。
 */
export const DEFAULT_SYNTH_SEED = 12345;

/** 程序化音源的缺省线性音量（spec.gain 未给时） */
export const DEFAULT_SYNTH_GAIN = 0.4;

/** ADSR 包络（毫秒；sustain 是 0..1 的保持电平） */
export interface SynthEnvelope {
  readonly attackMs: Ms;
  readonly decayMs: Ms;
  readonly sustain: number;
  readonly releaseMs: Ms;
}

/**
 * 程序化音源：不依赖素材文件，直接由参数合成。
 * 振荡器相位从 0 起算，同一份 spec 每次得到同样的样本。
 */
export interface SynthSpec {
  readonly wave: Waveform;
  /** 基频（Hz；noise 忽略） */
  readonly freq: number;
  /** 音分偏移（缺省 0） */
  readonly detune?: number;
  /** ADSR（缺省：5ms 起音 / 30ms 衰减 / 0.8 保持 / 80ms 释放） */
  readonly envelope?: SynthEnvelope;
  /** 时长（毫秒，> 0） */
  readonly durationMs: Ms;
  /**
   * 噪声波形的伪随机种子（缺省 `DEFAULT_SYNTH_SEED`）。
   * 只影响 noise：同 seed 必同样本，换 seed 换一条噪声；其余波形忽略。
   */
  readonly seed?: number;
  /** 线性音量（缺省 `DEFAULT_SYNTH_GAIN`） */
  readonly gain?: number;
  /** 声像 -1..1（缺省 0） */
  readonly pan?: number;
  /** 送往哪条总线（缺省 master） */
  readonly bus?: BusId;
}
