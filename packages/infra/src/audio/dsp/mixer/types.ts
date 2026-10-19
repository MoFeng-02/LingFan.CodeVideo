/**
 * 混音内核的类型与缺省值：构造参数、整段渲染输入，以及内核内部的运行期状态。
 *
 * 这些类型只服务 `dsp/mixer` 子模块，不对外导出；公共入口见 `dsp/index.ts`。
 */
import type {
  AudioGraph,
  AudioVoice,
  BusId,
  BusSpec,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import type { DuckUnit } from "../duck";
import type { EffectUnit } from "../effects";
import type { ProgramVoice, VoicePcm } from "../types";
import type { VoicePlan } from "../voice";

/** 缺省块尺寸（帧）：128 帧在 48kHz 下约 2.7ms，与音频工作线程的渲染量子一致 */
export const DEFAULT_BLOCK_FRAMES = 128;

/**
 * 流式混音器的构造参数。
 *
 * 采样率、声道数、时长与总线拓扑在构造时定死，之后只允许运行期改参数（见 `setBusParams`）；
 * 改这些值必须重建实例。
 */
export interface StreamingMixerOptions {
  /** 输出采样率（Hz，须 > 0）；与源采样率不同时内核逐样本线性插值重采样 */
  readonly sampleRate: number;
  /** 输出声道数（交错缓冲的行宽）；恰为 2 时才做摆位，其余声道数摆位恒 1 */
  readonly channels: number;
  /** 总时间线时长（毫秒）：声音的硬终界，也是循环 `untilMs` 的上界 */
  readonly durationMs: Ms;
  /** 总线拓扑与参数轨迹；父链/发送/侧链成环时构造即抛 name="SpecViolation" */
  readonly graph: AudioGraph;
  /** 块尺寸（帧，缺省 `DEFAULT_BLOCK_FRAMES`，至少 1）；只影响循环次数，不影响逐样本结果 */
  readonly blockFrames?: number;
}

/**
 * 整段渲染的输入：构造参数 + 全部声音。
 *
 * 只用于 `mixProgram`（导出端与测试）；预览端走 `StreamingMixer.addVoice` 逐条投递。
 */
export interface MixProgramInput extends StreamingMixerOptions {
  /** 参与混音的全部声音；顺序不影响结果（各声音独立叠加），后加入的逐样本相加 */
  readonly voices: readonly ProgramVoice[];
}

/** 运行期改总线参数时给出的字段：未给出的字段保持原值 */
export interface BusParamsPatch {
  /** 静态增益覆盖（线性幅度，钳到 ≥ 0） */
  gain?: number;
  /** 静态声像覆盖（-1..1） */
  pan?: number;
  /** 静音覆盖 */
  mute?: boolean;
  /** 独奏覆盖 */
  solo?: boolean;
}

/** 本块逐帧的自动化参数：每条总线一次求值，主循环与独奏判定只读 */
export interface BlockParams {
  /** 逐帧线性增益 */
  readonly gain: Float32Array;
  /** 逐帧声像（-1..1） */
  readonly pan: Float32Array;
  /** 逐帧静音（1 = 静音） */
  readonly mute: Uint8Array;
  /** 逐帧独奏（1 = 独奏） */
  readonly solo: Uint8Array;
}

/** 一条总线的运行期状态：块缓冲与效果链实例（缓冲每块复用，不逐块分配） */
export interface BusRuntime {
  /** 总线 id */
  readonly id: BusId;
  /** 总线声明（静态参数与效果链规格） */
  readonly spec: BusSpec;
  /** 效果链实例，按声明顺序串联 */
  readonly effects: EffectUnit[];
  /** 处理后的块输出（长度 = blockFrames × channels） */
  readonly out: Float32Array;
}

/** 挂在目标总线上的侧链压制：来源总线 + 有状态的压制单元 */
export interface DuckEntry {
  /** 来源总线（其输出已在本块算好） */
  readonly from: BusRuntime;
  /** 压制单元（包络状态跨块保留） */
  readonly unit: DuckUnit;
}

/** 一条已加入的声音：声明 + PCM + 目标总线 + 求值后的时间线计划 */
export interface VoiceEntry {
  /** 声音声明（运行期操作会替换它） */
  voice: AudioVoice;
  /** 已解码 PCM */
  pcm: VoicePcm;
  /** 目标总线 id（未登记的总线在加入时退回 master） */
  bus: BusId;
  /** 当前时间线计划（操作追加后重新求值） */
  plan: VoicePlan;
}

/** 运行期改的静态参数：从 from 线性过渡到 to（不产生折点，只是覆盖同一段） */
export interface LiveRamp {
  /** 起点值（改动时刻的当前有效值） */
  from: number;
  /** 目标值（增益已钳到 ≥ 0，声像已钳到 -1..1） */
  to: number;
  /** 过渡起点（全局毫秒） */
  startMs: Ms;
  /** 过渡时长（毫秒）；≤ 0 表示立即生效 */
  rampMs: Ms;
}

/** 来源总线 → 它的发送列表（构造时按来源分组，渲染时按序累加） */
export type SendTable = Map<BusId, readonly SendSpec[]>;
