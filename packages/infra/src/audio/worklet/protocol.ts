/** 预览端与音频线程之间的消息协议：主线程只发数据，处理器只做运算。 */
import type {
  AudioGraph,
  AudioVoice,
  BusUpdate,
  Ms,
} from "@lingfan-video/contracts";

/** 声音的 PCM 载荷（可转移）：与内核的 VoicePcm 同形 */
export interface PcmPayload {
  data: Float32Array;
  sampleRate: number;
  channels: number;
  durationMs: Ms;
}

/** 主线程 → 音频线程 */
export type MixerMessage =
  | {
      readonly type: "init";
      readonly sampleRate: number;
      readonly channels: number;
      readonly durationMs: Ms;
      readonly graph: AudioGraph;
    }
  | {
      readonly type: "voice";
      readonly voice: AudioVoice;
      readonly pcm: PcmPayload;
    }
  | { readonly type: "bus"; readonly update: BusUpdate; readonly atMs: Ms }
  | {
      readonly type: "gain";
      readonly voiceId: string;
      readonly atMs: Ms;
      readonly value: number;
      readonly rampMs: Ms;
    }
  | {
      readonly type: "rate";
      readonly voiceId: string;
      readonly atMs: Ms;
      readonly value: number;
    }
  | {
      readonly type: "stop";
      readonly voiceId: string;
      readonly atMs: Ms;
      readonly fadeMs: Ms;
    };

/** 音频线程 → 主线程 */
export type MixerAck =
  | { readonly type: "started"; readonly atSec: number }
  | { readonly type: "error"; readonly message: string };

/** 处理器注册名（主线程与处理器共享同一常量） */
export const MIXER_PROCESSOR = "lingfan-preview-mixer";
