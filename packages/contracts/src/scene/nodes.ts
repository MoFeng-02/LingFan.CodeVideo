import type { Ms } from "../shared/units";
import type { Handle, Scheduler } from "../scheduler";
import type { FrameState } from "../feedback";
import type { CanvasEnv, Scene } from "./entities";

/** step 回调：返回 FrameState 即发布状态（经 key 化聚合合并），返回 void 无状态发布 */
export type StepFn = (ctx: StepContext) => FrameState | void;

/** step 选项：仅 at/after/hold 三项 */
export interface StepOptions {
  at?: Ms;
  after?: Ms;
  hold?: boolean;
}

export interface StepContext extends CanvasEnv {
  t: Ms;
  frameIndex: number;
  totalTime: Ms;
  fps: number;
  deltaTime: Ms;
  localT: Ms;
  duration: Ms;
  /** 0..1，= localT / duration */
  progress: number;
  spawn: <S>(scene: Scene<S>, options: SpawnOptionsLike) => Handle;
  scheduler: Scheduler;
}

/** 避免与 entities 循环引用的窄化别名（结构与 SpawnOptions 一致） */
export type SpawnOptionsLike = {
  key: string;
  at?: Ms;
  duration?: Ms;
  forever?: boolean;
};

/** loop 统一对象参数：省略 ms = 无固定迭代窗（fn 自管 next()/stop() 推进节奏） */
export interface LoopSpec {
  ms?: Ms;
  times?: number;
  fn: (ctx: LoopContext) => void;
}

export interface LoopContext extends CanvasEnv {
  parentT: Ms;
  frameIndex: number;
  fps: number;
  deltaTime: Ms;
  iteration: number;
  iterationT: Ms;
  /** 0..1，= iterationT / ms（无 ms 时无意义，恒 0） */
  iterationProgress: number;
  next(): void;
  stop(): void;
  spawn: <S>(scene: Scene<S>, options: SpawnOptionsLike) => Handle;
  scheduler: Scheduler;
}
