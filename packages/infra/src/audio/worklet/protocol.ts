/** 预览端与音频线程之间的消息协议：主线程只发数据，处理器只做运算。 */
import type {
  AudioGraph,
  AudioVoice,
  BusUpdate,
  Ms,
} from "@lingfan-video/contracts";

/**
 * 声音的 PCM 载荷（可转移）：与内核的 VoicePcm 同形。
 *
 * `data` 的底层缓冲要转移给音频线程（`postMessage(msg, [data.buffer])`）；
 * 若缓存的样本还要复用，发送前必须先复制（切片），转移后原视图即失效。
 */
export interface PcmPayload {
  /** 交错样本：长度 = frames × channels */
  data: Float32Array;
  /** 采样率（Hz） */
  sampleRate: number;
  /** 声道数（≥ 1；混音内核按需折叠/复制） */
  channels: number;
  /** 源时长（毫秒） */
  durationMs: Ms;
}

/**
 * 主线程 → 音频线程。
 *
 * 所有 `atMs` 都是全局时间线毫秒，由主线程按同一时钟换算后下发；
 * 音频线程不做单位换算，只把消息转成内核调用。
 */
export type MixerMessage =
  | {
      /** 初始化：采样率、输出声道数、总时长与总线图（须最先发） */
      readonly type: "init";
      /** 设备采样率（Hz） */
      readonly sampleRate: number;
      /** 输出声道数（预览固定 2） */
      readonly channels: number;
      /** 总时长（毫秒，音频线程据此停止） */
      readonly durationMs: Ms;
      /** 总线图（无总线时为空图） */
      readonly graph: AudioGraph;
    }
  | {
      /** 登记一条声音（可多次发送；后到的与已有声音叠加） */
      readonly type: "voice";
      /** 声音声明（全局起点、增益/声像/循环/变速、运行期操作） */
      readonly voice: AudioVoice;
      /** 该声音已解码/合成的 PCM */
      readonly pcm: PcmPayload;
    }
  | {
      /** 改总线参数（可带过渡） */
      readonly type: "bus";
      /** 目标参数（缺省字段不动） */
      readonly update: BusUpdate;
      /** 生效时刻（全局毫秒） */
      readonly atMs: Ms;
    }
  | {
      /** 改某条声音的音量 */
      readonly type: "gain";
      /** 目标声音 id（与 AudioVoice.id 对应） */
      readonly voiceId: string;
      /** 生效时刻（全局毫秒） */
      readonly atMs: Ms;
      /** 目标线性增益（0 = 静音，1 = 原始电平） */
      readonly value: number;
      /** 过渡时长（毫秒，0 = 立即） */
      readonly rampMs: Ms;
    }
  | {
      /** 改某条声音的速率（变速即变调） */
      readonly type: "rate";
      /** 目标声音 id */
      readonly voiceId: string;
      /** 生效时刻（全局毫秒） */
      readonly atMs: Ms;
      /** 目标速率（> 0，1 = 原速） */
      readonly value: number;
      /** 过渡时长（毫秒，0 = 立即；期间速率从当前值线性爬到目标值） */
      readonly rampMs: Ms;
    }
  | {
      /** 停某条声音（带收尾淡出） */
      readonly type: "stop";
      /** 目标声音 id */
      readonly voiceId: string;
      /** 停声时刻（全局毫秒） */
      readonly atMs: Ms;
      /** 收尾淡出长度（毫秒，0 = 立即静音） */
      readonly fadeMs: Ms;
    };

/**
 * 音频线程 → 主线程。
 *
 * `started` 是启动确认（主线程等到它才开始计时与下发播放操作）；
 * `error` 只带可读原因，音频线程不抛异常到主线程。
 */
export type MixerAck =
  | {
      /** 启动确认：处理器已在音频线程跑起来 */
      readonly type: "started";
      /** 启动时刻（AudioContext 秒，即 currentTime 基准） */
      readonly atSec: number;
    }
  | {
      /** 启动或运行期错误 */
      readonly type: "error";
      /** 可读错误原因 */
      readonly message: string;
    };

/** 处理器注册名（主线程与处理器共享同一常量） */
export const MIXER_PROCESSOR = "lingfan-preview-mixer";
