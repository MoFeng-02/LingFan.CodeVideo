import type { Ms } from "../shared/units";
import type { Handle, Scheduler } from "../scheduler";
import type { FrameState } from "../feedback";
import type { AudioClip, AudioHandle, AudioOptions } from "../audio";
import type { CanvasEnv, Scene } from "./entities";

/** 运行期音频能力：与 step/loop/spawn 同为上下文方法（能力即上下文，无全局单例） */
export interface AudioEnv {
  /** 立刻发声并返回句柄；寿命 = 源播完 / stop() / 总时间线尾 */
  audio(clip: AudioClip, options?: AudioOptions): AudioHandle;
}

/** step 回调：返回 FrameState 即发布状态（经 key 化聚合合并），返回 void 无状态发布 */
export type StepFn = (ctx: StepContext) => FrameState | void;

/** step 选项：at/after/hold + fps（本单元采样密度；缺省继承） */
export interface StepOptions {
  at?: Ms;
  after?: Ms;
  hold?: boolean;
  /** 单元声明帧率：帧池贡献 = 窗口时长 × fps（缺省 = 继承链/基础帧率） */
  fps?: number;
}

export interface StepContext extends CanvasEnv, AudioEnv {
  t: Ms;
  frameIndex: number;
  totalTime: Ms;
  /** 本单元有效帧率（单元声明 > spawn 链 > 基础） */
  fps: number;
  /** = 1000 / 本单元有效帧率 */
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
  fps?: number;
};

/** loop 统一对象参数：省略 ms = 无固定迭代窗（fn 自管 next()/stop() 推进节奏） */
export interface LoopSpec {
  ms?: Ms;
  times?: number;
  fn: (ctx: LoopContext) => void;
  /** 本 loop 采样密度（缺省 = 继承） */
  fps?: number;
}

export interface LoopContext extends CanvasEnv, AudioEnv {
  parentT: Ms;
  frameIndex: number;
  /** 本单元有效帧率（单元声明 > spawn 链 > 基础） */
  fps: number;
  /** = 1000 / 本单元有效帧率 */
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
