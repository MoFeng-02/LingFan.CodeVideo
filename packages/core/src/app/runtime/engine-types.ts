import type {
  AssetSource,
  AudioGraph,
  AudioOutput,
  AudioVoice,
  BusPoint,
  BusSpec,
  DuckRule,
  FrameBitmap,
  FrameIndex,
  FrameState,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import type {
  CompiledSegment,
  SceneInternal,
} from "../../domain/simulation/types";
import type { MutableVoice } from "./audio-runtime";
import type { DeclaredAutomation } from "./bus-automation";

/** 链上一段时间线占位（transition 提前收窗：end 取 activeEnd） */
export interface ChainSpan {
  scene: SceneInternal<unknown>;
  seg: CompiledSegment;
  start: Ms;
  end: Ms;
}

/** 一条 spawn 链（同 key 去重的调度单位） */
export interface SpawnChain {
  key: string;
  spans: ChainSpan[];
  start: Ms;
  end: Ms;
  killed: boolean;
  /** 消亡窗口起点（kill/dispose 带 fadeOut 时写入；窗口内继续求值） */
  dyingFrom?: Ms;
  /** 消亡窗口终点（含）；t >= 此值 → 真正出池 */
  dyingUntil?: Ms;
}

export interface EngineOptions {
  fps: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  headless: boolean;
  /** 资产来源（setup 阶段 assets.load 的后端；缺省 = fail-fast 实现） */
  assets?: AssetSource;
  /** 预览端实时音频输出（注入 = 运行期发射即时发声；缺省 = 只记录声音） */
  audioOut?: AudioOutput;
}

export interface RunSummary {
  frames: number;
  durationMs: Ms;
  lastState: FrameState;
  /** 全时间线声音记录（登记期声明 + 运行期发射；导出端据此离线渲染） */
  audioVoices: readonly AudioVoice[];
  /** 全时间线音频图（总线拓扑 + 参数轨迹；导出端离线混音用） */
  audioGraph: AudioGraph;
}

/** 运行期总线参数（句柄改动的当前值；未登记 = master 直连） */
export interface BusParams {
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

/**
 * 单参数过渡：回调内 gain/pan 带 rampMs 时登记，逐帧采样时求值。
 * 起点值取登记时刻的**有效**参数值——过渡未结束时再次登记，从当前插值处重新起坡。
 */
export interface ParamRamp {
  /** 起点时刻（时间线毫秒） */
  fromMs: Ms;
  /** 过渡时长（毫秒，> 0） */
  ms: Ms;
  /** 起点值（登记时刻的有效值） */
  from: number;
  /** 目标值 */
  to: number;
}

/** 总线运行期过渡：每个参数至多一条在途过渡 */
export interface BusRampState {
  gain?: ParamRamp;
  pan?: ParamRamp;
}

/** 引擎可变状态：跨原子单元共享（自由函数显式传参，不散全局） */
export interface TimelineState {
  opts: EngineOptions;
  deadUnits: Set<string>; // `${sceneId}/${unitKey}`：硬死（立即不求值）
  /** 单元级消亡窗口：key → {from,until}；窗口内继续求值并暴露 disposing */
  dyingUnits: Map<string, { from: Ms; until: Ms }>;
  spawnChains: SpawnChain[];
  /** 声音记录（登记期已全局化；运行期发射追加） */
  audioVoices: MutableVoice[];
  /** 声音 id 序号（确定性分配） */
  voiceSeq: number;
  /** 事件去重登记（确定性键：作用域 + 单元实例 + 迭代/实例 id） */
  onceKeys: Set<string>;
  /** 音频图拓扑（登记期声明；同 id / 同 from→to 覆盖） */
  busSpecs: Map<string, BusSpec>;
  sends: Map<string, SendSpec>;
  ducks: Map<string, DuckRule>;
  /** 运行期总线参数当前值 */
  busParams: Map<string, BusParams>;
  /** 运行期参数过渡（gain/pan 带 rampMs 时登记；逐帧采样时按时刻求值） */
  busRamps: Map<string, BusRampState>;
  /** 上一次逐帧参数下发时刻（预览端过渡时长 = 相邻帧间隔） */
  busFlushAt?: Ms;
  /** 参数轨迹（逐帧采样；program 构建时按时间排序） */
  busPoints: Map<string, BusPoint[]>;
  /** 总线消亡窗口 */
  busKill: Map<string, { from: Ms; until: Ms }>;
  /** 声明式自动化队列（全局时刻；每帧推进游标，按声明时刻起坡） */
  busAutomation: Map<string, DeclaredAutomation>;
  /** 未给 ms 的 loop：迭代号与迭代起点（按单元键登记） */
  selfPaced: Map<string, { iteration: number; iterStart: Ms }>;
  spans: ChainSpan[];
  timelineEnd: Ms;
  /** 当前求值时间（句柄操作／alive 判定的时间轴依据） */
  nowMs: Ms;
  /** 是否处于回调执行中（句柄操作的合法窗口） */
  inCallback: boolean;
}

/** 引擎运行期句柄集合（frame-eval / spawn-handle 间共享的最小面） */
export interface EvalDeps {
  state: TimelineState;
  aggregator: import("../../domain/simulation").StateAggregator;
  painterPaint: (f: FrameIndex, t: Ms, state: FrameState) => FrameBitmap;
}
