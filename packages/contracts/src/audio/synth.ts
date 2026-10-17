import type { Ms } from "../shared/units";
import type { BusId } from "./graph";

/** 振荡器波形（noise = 确定性伪随机，同一份程序每次导出同一样本） */
export type Waveform = "sine" | "square" | "saw" | "triangle" | "noise";

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
  /** 线性音量（缺省 0.4） */
  readonly gain?: number;
  /** 声像 -1..1（缺省 0） */
  readonly pan?: number;
  /** 送往哪条总线（缺省 master） */
  readonly bus?: BusId;
}
