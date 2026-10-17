import type {
  AssetSource,
  FrameBitmap,
  FrameIndex,
  FrameState,
  Ms,
} from "@lingfan-video/contracts";
import type { CompiledAudio } from "../../domain/simulation/types";
import type {
  CompiledSegment,
  SceneInternal,
} from "../../domain/simulation/types";

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
}

export interface RunSummary {
  frames: number;
  durationMs: Ms;
  lastState: FrameState;
  /** 全时间线音频事件（组合根混音用；事件模型不参与帧调度） */
  audioEvents: import("./engine-types").AudioEvent[];
}

/** 引擎可变状态：跨原子单元共享（自由函数显式传参，不散全局） */
export interface TimelineState {
  opts: EngineOptions;
  deadUnits: Set<string>; // `${sceneId}/${unitKey}`
  spawnChains: SpawnChain[];
  audioEvents: AudioEvent[];
  form3: Map<string, { iteration: number; iterStart: Ms }>;
  spans: ChainSpan[];
  timelineEnd: Ms;
}

/** 引擎运行期钩子（预览端用：时间线建好后即可预排音频，不必等正片跑完） */
export interface RunHooks {
  /** 时间线构建完成即刻回调：全时间线音频事件 + 总时长 */
  onAudioScript?(events: AudioEvent[], durationMs: Ms): void;
}

/** 引擎运行期句柄集合（frame-eval / spawn-handle 间共享的最小面） */
export interface EvalDeps {
  state: TimelineState;
  aggregator: import("../../domain/simulation").StateAggregator;
  painterPaint: (f: FrameIndex, t: Ms, state: FrameState) => FrameBitmap;
}

/** 全时间线音频事件（span 相对锚点已换算为全局绝对时间；forever 循环圈已展开） */
export interface AudioEvent extends CompiledAudio {
  /** 全局绝对时间（时间线轴） */
  globalAtMs: Ms;
}
