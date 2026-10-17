import type { Ms } from "../shared/units";
import type { KillOptions } from "../scheduler/entities";

/** 总线 id；顶层混音母线固定为 `master`，所有未显式指派的 bus 都挂在它下面 */
export type BusId = string;

/** 顶层母线 id（隐式存在，不需要登记） */
export const MASTER_BUS: BusId = "master";

/** 滤波器类型（B4-1 首版：biquad） */
export type FilterKind = "lowpass" | "highpass" | "bandpass";

/** 总线效果：滤波器（静态参数，逐帧自动化留 B4-3） */
export interface FilterSpec {
  readonly kind: "filter";
  readonly type: FilterKind;
  /** 截止/中心频率（Hz） */
  readonly frequency: number;
  /** Q 值（bandpass 建议 0.5~8；缺省 0.707） */
  readonly q?: number;
}

/** 总线效果：压缩器（静态参数） */
export interface CompressorSpec {
  readonly kind: "compressor";
  readonly thresholdDb: number;
  readonly ratio: number;
  readonly attackMs: Ms;
  readonly releaseMs: Ms;
  /** 软拐点宽度（dB，缺省 6） */
  readonly kneeDb?: number;
}

/** 总线效果：延迟线（确定性；B4-2） */
export interface DelaySpec {
  readonly kind: "delay";
  /** 延迟时间（毫秒，> 0） */
  readonly delayMs: Ms;
  /** 反馈量 0..0.95（缺省 0.3） */
  readonly feedback?: number;
  /** 干湿比 0..1（缺省 0.5） */
  readonly mix?: number;
}

/** 总线效果：简化 Freeverb（8 comb + 4 allpass，确定性；B4-2） */
export interface ReverbSpec {
  readonly kind: "reverb";
  /** 房间大小 0..1（缺省 0.7） */
  readonly roomSize?: number;
  /** 高频阻尼 0..1（缺省 0.4） */
  readonly damping?: number;
  /** 干湿比 0..1（缺省 0.35） */
  readonly mix?: number;
}

export type EffectSpec = FilterSpec | CompressorSpec | DelaySpec | ReverbSpec;

/**
 * 总线规格（拓扑在登记期定死；运行期只能改参数/消杀，不能改父子关系）。
 * `effects` 按数组顺序作用于该总线的输入，然后才过 gain/pan 与 duck。
 */
export interface BusSpec {
  readonly id: BusId;
  /** 父总线（缺省 master）；成环/未知父在装配时报 spec_violation */
  readonly parent?: BusId;
  readonly gain?: number;
  readonly pan?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
  readonly effects?: readonly EffectSpec[];
}

/** 发送：源总线输出按 amount 送进目标总线（缺省 post-fader；pre = 取效果前信号） */
export interface SendSpec {
  readonly from: BusId;
  readonly to: BusId;
  readonly amount: number;
  readonly pre?: boolean;
}

/**
 * 侧链压制规则（确定性 DSP）：`from` 总线的输出包络超过阈值时，把 `to` 总线压低。
 * 压制量按 attack/hold/release 平滑；同一采样率下导出可复算、可写单元测试。
 */
export interface DuckRule {
  readonly from: BusId;
  readonly to: BusId;
  /** 最多压低多少 dB（正数） */
  readonly amountDb: number;
  readonly attackMs?: Ms;
  readonly holdMs?: Ms;
  readonly releaseMs?: Ms;
  /** 触发阈值（dBFS，缺省 -30） */
  readonly thresholdDb?: number;
}

/** 总线参数采样点（每帧回调设置的目标值；混音器在相邻点间线性插值） */
export interface BusPoint {
  readonly atMs: Ms;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
}

/** 单总线的参数轨迹（atMs 严格递增；缺省参数 = 总线规格里的静态值） */
export interface BusAutomation {
  readonly bus: BusId;
  readonly points: readonly BusPoint[];
}

/**
 * 整条时间线的音频图：拓扑（静态）+ 参数轨迹（逐帧）。
 * 与 `AudioProgram.voices` 一起组成「样本 = f(program)」的完整输入。
 */
export interface AudioGraph {
  readonly buses: readonly BusSpec[];
  readonly sends: readonly SendSpec[];
  readonly ducks: readonly DuckRule[];
  readonly automation: readonly BusAutomation[];
}

/** 累计发送的自增计数（预览端不还原 sends，导出端全量参与——诚实边界见 15 号 §5.8） */
export type BusSendCount = number;

/**
 * 运行期总线句柄：回调内改参数、按名字持有时长（kill 支持 fadeOut 消亡窗口，
 * 语义与 §9.13 视觉消亡一致——窗口内参数继续被求值，窗口结束才出图）。
 */
export interface BusHandle {
  readonly id: BusId;
  readonly alive: boolean;
  /** 改增益（rampMs 内线性过渡；缺省立即） */
  gain(value: number, rampMs?: Ms): void;
  /** 改摆位 -1..1（rampMs 内线性过渡） */
  pan(value: number, rampMs?: Ms): void;
  mute(value: boolean): void;
  solo(value: boolean): void;
  /** 消杀（缺省立即静音出图；fadeOut 给淡出窗口） */
  kill(options?: KillOptions): void;
}

/**
 * 运行期音频图能力：任何 step/loop/wait 回调都拿得到。
 * 拓扑在登记期定死；运行期 `bus(id)` 拿句柄改参数，或按需补登记一条总线（预览端可懒建）。
 */
export interface AudioGraphEnv {
  bus(id: BusId, spec?: Omit<BusSpec, "id">): BusHandle;
  /** 登记一条发送（重复登记 = 覆盖同 from→to 的量） */
  send(spec: SendSpec): void;
  /** 登记一条侧链压制规则（重复登记 = 覆盖同 from→to 的规则） */
  duck(rule: DuckRule): void;
}
