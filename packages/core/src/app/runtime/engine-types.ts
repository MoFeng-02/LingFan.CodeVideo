import type {
  AssetSource,
  AudioOutput,
  AudioVoice,
  FrameBitmap,
  FrameIndex,
  FrameState,
  Ms,
} from "@lingfan-video/contracts";
import type {
  CompiledSegment,
  SceneInternal,
} from "../../domain/simulation/types";
import type { MutableVoice } from "./audio-runtime";

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
}

/** 引擎可变状态：跨原子单元共享（自由函数显式传参，不散全局） */
export interface TimelineState {
  opts: EngineOptions;
  deadUnits: Set<string>; // `${sceneId}/${unitKey}`
  spawnChains: SpawnChain[];
  /** 声音记录（登记期已全局化；运行期发射追加） */
  audioVoices: MutableVoice[];
  /** 声音 id 序号（确定性分配） */
  voiceSeq: number;
  form3: Map<string, { iteration: number; iterStart: Ms }>;
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
