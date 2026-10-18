import type { Ms } from "../shared/units";
import type { AudioClip } from "./entities";
import type { GainLike } from "./gain";
import type { SynthSpec } from "./synth";
import type { AudioGraph, BusId, BusPoint } from "./graph";

/**
 * 时间映射锚点：时间线 atMs 处应播放源的 srcMs（均相对声音起点）。
 * 相邻锚点之间线性插值——斜率即播放速率，同时也是音高倍率（磁带式重采样）。
 * 末个锚点之后斜率延续（中途加速后不给恢复锚点 = 一直保持该速率）。
 * srcMs 取 "end" 表示「源播完处」，必须是末个锚点：用于把整段音频压缩/拉伸到
 * 恰好填满声音区间（自然收尾，无需知道源时长）。
 */
export interface WarpPoint {
  /** 声音内局部时间锚点（毫秒，严格递增；首个可为 0，其前隐式从原点插入） */
  atMs: Ms;
  /** 该时刻对应的源内位置（毫秒）或源尾标志 */
  srcMs: Ms | "end";
}

/** 包络折点：声音局部毫秒 → 乘子；`fromEnd` 时 atMs 表示「离声音终点还有多少毫秒」 */
export interface EnvelopePoint {
  /** 折点时刻（毫秒；相对声音起点；`fromEnd` 为真时从声音终点倒着量） */
  readonly atMs: Ms;
  /** 该点的增益乘子（线性倍率，与基础增益相乘） */
  readonly value: number;
  /** true = atMs 从声音终点倒量：用于收尾淡出，源真实时长未知也成立 */
  readonly fromEnd?: boolean;
}

/**
 * 音量包络：在声音局部时间上的分段线性乘子，首点前取首值、末点后取末值。
 * 与基础增益相乘（`gain(0.5, { envelope: fadeIn(200) })` = 从 0 升到 0.5）。
 * 纯数据，构造期校验；导出逐样本取值、预览折算成同一组折点——两端同源。
 */
export interface Envelope {
  /** 折点序列（按声音内实际时间递增；`fromEnd` 点由实现折算到终点侧） */
  readonly points: readonly EnvelopePoint[];
}

/** 增益与包络：线性幅度（也可写 `{ db }` 由组合子折算）；fade 在时间线毫秒域（不随变速伸缩） */
export interface AudioGain {
  /** 基础增益（线性幅度；`{ db }` 写法在构造期已折算成线性值） */
  readonly value: number;
  /** 淡入时长（时间线毫秒；缺省无淡入） */
  readonly fadeIn?: Ms;
  /** 淡出时长（时间线毫秒；缺省无淡出） */
  readonly fadeOut?: Ms;
  /** 逐段包络（与 value 相乘；折点为声音局部时间） */
  readonly envelope?: Envelope;
}

/** 立体声摆位：-1 全左 ~ 1 全右（非立体声输出恒居中） */
export interface AudioPan {
  /** 摆位（-1..1） */
  readonly value: number;
}

/** 循环：省略 untilMs = 铺到总时间线尾（终界仍是时间线，不是无限） */
export interface AudioLoop {
  /** 循环终点（时间线毫秒；省略 = 铺到总时间线尾） */
  readonly untilMs?: Ms;
}

/**
 * 变速：恒速（rate(2) = 两倍速两倍音高）或锚点表（warp(...) = 分段线性、锚点即踩点）。
 * 斜率 = 速率 = 音高倍率，变速即变调（磁带式）；速率须恒正，不支持倒放。
 */
export type AudioRate =
  | { readonly kind: "rate"; readonly value: number }
  | { readonly kind: "warp"; readonly points: readonly WarpPoint[] };

/**
 * 音频选项：每一项都是构造期校验过的强类型值（由组合子产出），
 * 不再是一袋可选原始数字——写错单位/把相邻概念混用会在构造处暴露。
 */
export interface AudioOptions {
  /**
   * 起播偏移（毫秒），两种发射语义不同：
   * - 登记期 `env.audio` / `bgm`：相对**登记位置**；
   * - 运行期 `ctx.audio`：相对**发射时刻**的延迟（负值按 0）。
   */
  readonly at?: Ms;
  /** 音量与包络（缺省 1 = 原始电平） */
  readonly gain?: AudioGain;
  /** 声像（缺省 0 = 居中） */
  readonly pan?: AudioPan;
  /** 循环（缺省不循环，源播完即止） */
  readonly loop?: AudioLoop;
  /** 变速（缺省原速） */
  readonly rate?: AudioRate;
  /** 送往哪条总线（缺省 master；总线拓扑与参数见 audio/graph.ts） */
  readonly bus?: BusId;
}

/**
 * 运行期音频句柄：发声后立刻拿到的唯一操作面。
 * 所有操作以「当前回调的时间」为生效时刻（在 step/loop 回调内调用；回调外调用报 spec_violation）。
 * 生命周期：源自然播完 / stop() / 总时间线尾——引擎不因幕、段、链边界自动杀声音。
 */
export interface AudioHandle {
  /** 实例标识（同一程序内唯一，与句柄操作记录里的条目标记对应） */
  readonly id: string;
  /** 起播时间（全局时间线毫秒） */
  readonly startedAtMs: Ms;
  /** 是否仍在发声（stop 之后或源播完即 false） */
  readonly alive: boolean;
  /** 停止发声；fadeOutMs 给出收尾淡出 */
  stop(fadeOutMs?: Ms): void;
  /** 改音量（rampMs 内线性过渡；可写线性幅度或 `{ db }`） */
  setGain(value: GainLike, rampMs?: Ms): void;
  /** 改速率（rampMs 内线性过渡；变速即变调） */
  setRate(value: number, rampMs?: Ms): void;
}

/** 句柄操作记录：导出端据此在时间线上求包络，样本仍是时间线纯函数 */
export type AudioOp =
  | { readonly kind: "stop"; readonly atMs: Ms; readonly fadeMs: Ms }
  | {
      readonly kind: "gain";
      readonly atMs: Ms;
      readonly value: number;
      readonly rampMs: Ms;
    }
  | {
      readonly kind: "rate";
      readonly atMs: Ms;
      readonly value: number;
      readonly rampMs: Ms;
    };

/** 一个声音实例（全局时间线坐标；登记期与运行期发射同一形态） */
export interface AudioVoice {
  /** 实例标识（同一程序内唯一；导出端与预览端用它对齐同一条声音） */
  readonly id: string;
  /** 声音素材（有 `synth` 时只作占位身份） */
  readonly clip: AudioClip;
  /** 起播时间（全局时间线毫秒） */
  readonly startMs: Ms;
  /** 音量与包络（缺省 1） */
  readonly gain: AudioGain;
  /** 声像（缺省 0 = 居中） */
  readonly pan: AudioPan;
  /** null = 不循环 */
  readonly loop: AudioLoop | null;
  /** null = 原速 */
  readonly rate: AudioRate | null;
  /** 运行期句柄操作（按时间排序；空 = 无操作） */
  readonly ops: readonly AudioOp[];
  /** 送往哪条总线（缺省 master） */
  readonly bus?: BusId;
  /** 程序化音源：有该字段时 `clip` 只是占位身份，样本由 synth 求值 */
  readonly synth?: SynthSpec;
}

/** 整条时间线的音频程序：样本 = f(program)（同 program 必同样本） */
export interface AudioProgram {
  /** 程序时长（时间线毫秒；与画面时间线同轴） */
  readonly durationMs: Ms;
  /** 全部声音实例（登记期与运行期发射同表，按 startMs 排序不保证） */
  readonly voices: readonly AudioVoice[];
  /** 总线拓扑 + 参数轨迹（缺省 = 全部直连 master，等价旧行为） */
  readonly graph?: AudioGraph;
}

/** 解码后的音频资产最小形态（声道布局由实现持有） */
export interface DecodedAudio {
  /** 该解码结果对应的音频资产 */
  readonly clip: AudioClip;
  /** 采样率（Hz） */
  readonly sampleRate: number;
  /** 声道数 */
  readonly channels: number;
  /** 有效时长（毫秒） */
  readonly durationMs: Ms;
}

/**
 * 交叉无关样本块（时间线区间 [atMs, atMs+ms) 的 PCM）。
 * 块序列须自 0 起、按时间顺序连续、无空隙：接帧端按顺序拼接即整轨。
 */
export interface AudioSample {
  /** 该区间的交错 PCM（浮点 -1..1；声道数由 `AudioClock.channels` 声明） */
  data: Float32Array;
  /** 区间起点（时间线毫秒；块序列从 0 起、连续无空隙） */
  atMs: Ms;
}

/**
 * 音频时钟契约（导出端）：样本 = 时间线纯函数（同程序必同样本）。
 * 输出只依赖程序与实现声明的采样率/声道数——与视频帧率无关：
 * 帧率只决定画面采样密度，任何改变音频字节的帧率依赖都会破坏该承诺。
 */
export interface AudioClock {
  /** 输出采样率（导出格式决定；接帧端按此声明交轨） */
  readonly sampleRate: number;
  /** 输出声道数（交错布局；接帧端按此声明交轨） */
  readonly channels: number;
  /**
   * 求整条时间线的音频样本。
   * @param program 声音实例、总线拓扑与参数轨迹
   * @returns 自 0 起按时间顺序连续覆盖整条时间线的样本块
   */
  renderProgram(program: AudioProgram): Promise<AudioSample[]>;
  /**
   * 解码一个音频资产（供预览端取时长/采样率；导出端的解码由实现内部完成）。
   * @param clip 要解码的音频资产
   * @returns 解码后的格式与有效时长
   */
  decode(clip: AudioClip): Promise<DecodedAudio>;
}

/** 预览端总线参数更新：拓扑在 begin 时按 AudioGraph 建立，运行期只能改参数 */
export interface BusUpdate {
  /** 目标总线 id */
  readonly id: BusId;
  /** 目标增益（线性幅度） */
  readonly gain: number;
  /** 目标声像（-1..1） */
  readonly pan: number;
  /** 目标静音状态 */
  readonly mute: boolean;
  /** 目标独奏状态 */
  readonly solo: boolean;
  /** 过渡时长（毫秒；缺省立即生效） */
  readonly rampMs?: Ms;
  /** 目标时刻（时间线毫秒；缺省=现在，仅用于延迟对齐） */
  readonly at?: BusPoint["atMs"];
}

/**
 * 音频输出契约（预览端）：实时发声，允许非确定（延迟由平台时钟决定）。
 * begin 锚定时间线起点并预排登记期声音；start 承接运行期发射；
 * dispose 清场（重播/切幕）。导出端不用本端口，走 AudioClock。
 */
export interface AudioOutput {
  /**
   * 锚定时间线起点并预排登记期声音。
   * @param program 整条时间线的音频程序（总线拓扑在此时建立）
   */
  begin(program: AudioProgram): Promise<void>;
  /**
   * 承接一次运行期发射：立即开始（或在声音 startMs 到点时开始）发声。
   * @param voice 要发声的声音实例
   * @returns 该声音的实时操作对象
   */
  start(voice: AudioVoice): LiveVoice;
  /** 可选：运行期总线参数更新（不实现 = 预览忽略逐帧总线参数） */
  setBus?(update: BusUpdate): void;
  /** 清场：停止并释放全部声音与总线（重播/切幕前调用，重复调用安全） */
  dispose(): void;
}

/** 实时发声对象：操作以全局时间线毫秒为时刻（与导出端同一时间轴） */
export interface LiveVoice {
  /**
   * 停止发声。
   * @param atMs 生效时刻（全局时间线毫秒）
   * @param fadeMs 淡出时长（毫秒；0 = 立即静音）
   */
  stop(atMs: Ms, fadeMs: Ms): void;
  /**
   * 改音量。
   * @param atMs 生效时刻（全局时间线毫秒）
   * @param value 目标线性幅度
   * @param rampMs 过渡时长（毫秒；0 = 立即）
   */
  setGain(atMs: Ms, value: number, rampMs: Ms): void;
  /**
   * 改速率（变速即变调）。
   * @param atMs 生效时刻（全局时间线毫秒）
   * @param value 目标速率（恒正）
   * @param rampMs 过渡时长（毫秒；0 = 立即）
   */
  setRate(atMs: Ms, value: number, rampMs: Ms): void;
}
