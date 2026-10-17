import type {
  AssetSource,
  FrameBitmap,
  FrameIndex,
  FrameState,
  Ms,
} from "@lingfan-video/contracts";
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
}

/** 引擎可变状态：跨原子单元共享（自由函数显式传参，不散全局） */
export interface TimelineState {
  opts: EngineOptions;
  deadUnits: Set<string>; // `${sceneId}/${unitKey}`
  spawnChains: SpawnChain[];
  form3: Map<string, { iteration: number; iterStart: Ms }>;
  spans: ChainSpan[];
  timelineEnd: Ms;
}

/** 引擎运行期句柄集合（frame-eval / spawn-handle 间共享的最小面） */
export interface EvalDeps {
  state: TimelineState;
  aggregator: import("../../domain/simulation").StateAggregator;
  painterPaint: (f: FrameIndex, t: Ms, state: FrameState) => FrameBitmap;
}
