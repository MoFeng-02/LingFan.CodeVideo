import type { Ms } from "../shared/units";
import type { KillOptions } from "../scheduler/entities";
import type { GainLike } from "./gain";

/** 总线 id；顶层混音母线固定为 `master`，所有未显式指派的 bus 都挂在它下面 */
export type BusId = string;

/** 顶层母线 id（隐式存在，不需要登记） */
export const MASTER_BUS: BusId = "master";

/** 滤波器类型（biquad） */
export type FilterKind = "lowpass" | "highpass" | "bandpass";

/** 总线效果：滤波器 */
export interface FilterSpec {
  /** 效果种类判别符 */
  readonly kind: "filter";
  /** 滤波类型：低通 / 高通 / 带通 */
  readonly type: FilterKind;
  /** 截止/中心频率（Hz） */
  readonly frequency: number;
  /** Q 值（bandpass 建议 0.5~8；缺省 0.707） */
  readonly q?: number;
}

/** 总线效果：压缩器 */
export interface CompressorSpec {
  /** 效果种类判别符 */
  readonly kind: "compressor";
  /** 起压阈值（dBFS） */
  readonly thresholdDb: number;
  /** 压缩比（如 4 = 4:1） */
  readonly ratio: number;
  /** 起压时长（毫秒） */
  readonly attackMs: Ms;
  /** 释放时长（毫秒） */
  readonly releaseMs: Ms;
  /**
   * 软拐点宽度（dB，≥ 0）：缺省 0 = 硬拐点；给正值时在阈值上下各 half-knee 内
   * 按二次曲线过渡，两端与硬拐点曲线衔接。
   */
  readonly kneeDb?: number;
}

/** 总线效果：延迟线 */
export interface DelaySpec {
  /** 效果种类判别符 */
  readonly kind: "delay";
  /** 延迟时间（毫秒，> 0） */
  readonly delayMs: Ms;
  /** 反馈量 0..0.95（缺省 0.3） */
  readonly feedback?: number;
  /** 干湿比 0..1（缺省 0.5） */
  readonly mix?: number;
}

/** 总线效果：简化 Freeverb（8 comb + 4 allpass） */
export interface ReverbSpec {
  /** 效果种类判别符 */
  readonly kind: "reverb";
  /** 房间大小 0..1（缺省 0.7） */
  readonly roomSize?: number;
  /** 高频阻尼 0..1（缺省 0.4） */
  readonly damping?: number;
  /** 干湿比 0..1（缺省 0.35） */
  readonly mix?: number;
}

/** 总线效果：按 `kind` 判别的联合；沿 effects 数组顺序串联 */
export type EffectSpec = FilterSpec | CompressorSpec | DelaySpec | ReverbSpec;

/**
 * 总线规格（拓扑在登记期定死；运行期只能改参数/消杀，不能改父子关系）。
 * `effects` 按数组顺序作用于该总线的输入，然后才过 gain/pan 与 duck。
 */
export interface BusSpec {
  /** 总线 id：运行期 ctx.bus(id) 与 sending 都按它引用 */
  readonly id: BusId;
  /** 父总线（缺省 master）；父名未登记或指向自己时退回 master，父链/发送/侧链成环在装配时报 spec_violation */
  readonly parent?: BusId;
  /** 静态增益（线性幅度；缺省 1） */
  readonly gain?: number;
  /** 静态声像 -1..1（缺省 0） */
  readonly pan?: number;
  /** 是否静音（缺省 false） */
  readonly mute?: boolean;
  /** 是否独奏（缺省 false）；有 solo 时非 solo 总线静音 */
  readonly solo?: boolean;
  /** 效果链：按顺序串联，先于 gain/pan 与 duck 生效 */
  readonly effects?: readonly EffectSpec[];
}

/** 发送：源总线输出按 amount 送进目标总线（缺省 post-fader；pre = 取效果前信号） */
export interface SendSpec {
  /** 源总线 */
  readonly from: BusId;
  /** 目标总线 */
  readonly to: BusId;
  /** 发送量（0..1，相对源总线的静音比例） */
  readonly amount: number;
  /** true = 取效果前信号（pre-fader）；缺省 post-fader */
  readonly pre?: boolean;
}

/**
 * 侧链压制规则（确定性 DSP）：`from` 总线的输出包络超过阈值时，把 `to` 总线压低。
 * 压制量按 attack/hold/release 平滑；同一采样率下导出可复算、可写单元测试。
 */
export interface DuckRule {
  /** 触发源总线 */
  readonly from: BusId;
  /** 被压制的目标总线 */
  readonly to: BusId;
  /** 最多压低多少 dB（正数） */
  readonly amountDb: number;
  /** 压制起效时长（毫秒，缺省 10） */
  readonly attackMs?: Ms;
  /** 压制保持时长（毫秒，缺省 0：不保持，attack 后立即进 release） */
  readonly holdMs?: Ms;
  /** 恢复时长（毫秒，缺省 200） */
  readonly releaseMs?: Ms;
  /** 触发阈值（dBFS，缺省 -30） */
  readonly thresholdDb?: number;
}

/** 总线参数采样点（每帧回调设置的目标值；混音器在相邻点间线性插值） */
export interface BusPoint {
  /** 采样点时刻（时间线毫秒） */
  readonly atMs: Ms;
  /** 增益（线性幅度） */
  readonly gain: number;
  /** 声像 -1..1 */
  readonly pan: number;
  /** 是否静音 */
  readonly mute: boolean;
  /** 是否独奏 */
  readonly solo: boolean;
}

/** 单总线的参数轨迹（atMs 严格递增；缺省参数 = 总线规格里的静态值） */
export interface BusAutomation {
  /** 轨迹所属总线 */
  readonly bus: BusId;
  /** 参数采样点（按 atMs 递增） */
  readonly points: readonly BusPoint[];
}

/**
 * 声明式自动化点：登记期写下的参数计划，时间线推进到点即生效。
 * 只写要控制的参数（未写的参数不动）；rampMs = 从当前有效值线性过渡的时长，缺省立即。
 * 时刻相对声明它的段落起点，因此同一段被重复播放（spawn 循环圈）时自动同相位平移。
 * gain 可写线性幅度或 `{ db }`（折算由引擎做，轨迹里只留线性值）。
 */
export interface AutomationPoint {
  /** 相对本段起点的生效时刻（毫秒） */
  readonly atMs: Ms;
  /** 目标增益（线性幅度或 `{ db }`；缺省 = 不改） */
  readonly gain?: GainLike;
  /** 目标声像 -1..1（缺省 = 不改） */
  readonly pan?: number;
  /** 过渡时长（毫秒；缺省立即生效） */
  readonly rampMs?: Ms;
}

/** 单总线的声明式轨迹（atMs 严格递增；空点表 = 无计划） */
export interface BusAutomationSpec {
  /** 轨迹所属总线 */
  readonly bus: BusId;
  /** 计划点（按 atMs 严格递增） */
  readonly points: readonly AutomationPoint[];
}

/**
 * 整条时间线的音频图：拓扑（静态）+ 参数轨迹（逐帧）。
 * 与 `AudioProgram.voices` 一起组成「样本 = f(program)」的完整输入。
 */
export interface AudioGraph {
  /** 全部总线规格（不含隐式的 master） */
  readonly buses: readonly BusSpec[];
  /** 总线间发送 */
  readonly sends: readonly SendSpec[];
  /** 侧链压制规则 */
  readonly ducks: readonly DuckRule[];
  /** 逐帧总线参数轨迹 */
  readonly automation: readonly BusAutomation[];
}

/** 累计发送的自增计数（预览端不还原 sends，导出端全量参与） */
export type BusSendCount = number;

/**
 * 运行期总线句柄：回调内改参数、按名字持有时长。
 * kill 支持 fadeOut 窗口——窗口内参数继续被求值，窗口结束后失效。
 * gain/pan 的 rampMs：从**当前有效值**起线性过渡到目标值；过渡未结束时再次改参数，
 * 从当前插值处重新起坡。参数按帧采样（帧间由混音端线性插值），
 * 因此斜坡终点最多晚一帧对齐到采样点；rampMs ≤ 0 = 立即生效。
 */
export interface BusHandle {
  /** 总线 id */
  readonly id: BusId;
  /** 是否仍有效（消亡窗口内仍为 true） */
  readonly alive: boolean;
  /** 改增益（rampMs 内线性过渡；缺省立即；可写线性幅度或 `{ db }`） */
  gain(value: GainLike, rampMs?: Ms): void;
  /** 改摆位 -1..1（rampMs 内线性过渡；缺省立即） */
  pan(value: number, rampMs?: Ms): void;
  /** 静音开关 */
  mute(value: boolean): void;
  /** 独奏开关 */
  solo(value: boolean): void;
  /** 消杀（缺省立即静音出图；fadeOut 给淡出窗口） */
  kill(options?: KillOptions): void;
}

/**
 * 运行期音频图能力：任何 step/loop/wait 回调都拿得到。
 * 拓扑在登记期定死；运行期 `bus(id)` 拿句柄改参数，或按需补登记一条总线（预览端可懒建）。
 */
export interface AudioGraphEnv {
  /**
   * 取总线句柄（按需补登记）。
   * @param id 总线 id
   * @param spec 补登记时的规格（已存在则忽略；重复登记以最后声明为准）
   */
  bus(id: BusId, spec?: Omit<BusSpec, "id">): BusHandle;
  /** 登记一条发送（重复登记 = 覆盖同 from→to 的量） */
  send(spec: SendSpec): void;
  /** 登记一条侧链压制规则（重复登记 = 覆盖同 from→to 的规则） */
  duck(rule: DuckRule): void;
}
