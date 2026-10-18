/** 单一 DSP 内核的公共类型：解码后的声音 PCM 与「声音 + PCM」配对。 */
import type { AudioVoice, Ms } from "@lingfan-video/contracts";

/** 交错 Float32 PCM（采样率/声道数/时长由持有者给出） */
export interface VoicePcm {
  /** 交错样本：长度 = frames × channels */
  readonly data: Float32Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: Ms;
}

/** 参与混音的一条声音：声明 + 已解码 PCM（程序化音源由调用方先合成） */
export interface ProgramVoice {
  readonly voice: AudioVoice;
  readonly pcm: VoicePcm;
}
