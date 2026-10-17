import type { Ms } from "../shared/units";
import type { Handle, KillOptions, Scheduler } from "../scheduler";
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
  /** 可消杀名：`scheduler.kill(id)` 按名字找得到这个单元（缺省 = 编译键） */
  id?: string;
}

/**
 * 消亡过程能力：所有运行期单元都带。
 * `dispose()` 由函数**内部**触发自己的消亡；给了 fadeOut 则进入消亡窗口，
 * 窗口内本单元继续逐帧求值，`disposing=true`、`disposeProgress` 0→1。
 */
export interface Disposal {
  readonly disposing: boolean;
  readonly disposeProgress: number;
  /** 触发自己的消亡（缺省立即死；fadeOut 给消失过程） */
  dispose(options?: KillOptions): void;
}

export interface StepContext extends CanvasEnv, AudioEnv, Disposal {
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

/** wait 回调：不产帧，只在「同一时刻有别的活跃单元在产帧」的网格点上被调用 */
export type WaitFn = (ctx: WaitContext) => void;

/** wait 选项：可消杀名（与 step/loop 同一套具名消杀） */
export interface WaitOptions {
  id?: string;
}

/**
 * wait 回调上下文（B1）。
 * 能力集刻意**不含** canvas / step / loop / spawn / par：这段不产帧，
 * 若是能画、能开新的产帧路径，「空窗不产帧」的导出优化就失真了。
 * 真正需要画东西的段落用 step（会产帧），不要指望 wait 施舍。
 */
export interface WaitContext extends AudioEnv, Disposal {
  /** 全局时间线时刻 */
  t: Ms;
  frameIndex: number;
  totalTime: Ms;
  /** wait 窗内偏移 */
  localT: Ms;
  duration: Ms;
  /** 0..1，= localT / duration */
  progress: number;
  scheduler: Scheduler;
}

/** loop 统一对象参数：省略 ms = 无固定迭代窗（fn 自管 next()/stop() 推进节奏） */
export interface LoopSpec {
  ms?: Ms;
  times?: number;
  fn: (ctx: LoopContext) => void;
  /** 本 loop 采样密度（缺省 = 继承） */
  fps?: number;
  /** 可消杀名：scheduler.kill(id) 按名字找得到这个循环（缺省 = 编译键） */
  id?: string;
}

export interface LoopContext extends CanvasEnv, AudioEnv, Disposal {
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
