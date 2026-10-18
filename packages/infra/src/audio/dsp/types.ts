/** 单一 DSP 内核的公共类型：解码后的声音 PCM 与「声音 + PCM」配对。 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";

/**
 * 交错 Float32 PCM：一个声音解码（或合成）后的原始样本。
 *
 * 交错布局 = 每帧内按声道顺序排列（L,R,L,R…），长度恒为 `frames × channels`。
 * 时间线求值只用到 `durationMs` 作为源时长依据，取样由内核按秒/帧自行换算。
 */
export interface VoicePcm {
  /** 交错样本：长度 = frames × channels；混音时按原值累加，不做归一化 */
  readonly data: Float32Array;
  /** 采样率（Hz）：与输出采样率不同时由内核逐样本线性插值重采样，不做抗混叠滤波 */
  readonly sampleRate: number;
  /** 声道数：1 = 单声道（铺轨时复制到每个输出声道），≥2 = 按声道序号取用，不足的声道取最后一路 */
  readonly channels: number;
  /** 样本时长（毫秒）：不循环时的源终界，也是 rate/warp 映射的右端点 */
  readonly durationMs: Ms;
}

/**
 * 参与混音的一条声音：声明 + 已解码 PCM。
 *
 * 混音器只消费这一对数据：声明决定起止、增益、摆位、循环、变速与总线；
 * PCM 决定源内容与源时长。程序化音源（synth）须由调用方先用 `renderSynth` 合成再传入。
 */
export interface ProgramVoice {
  /** 声音声明：时间单位一律为毫秒，`startMs` 是总时间线上的绝对起点 */
  readonly voice: AudioVoice;
  /** 该声音的 PCM 样本 */
  readonly pcm: VoicePcm;
}
