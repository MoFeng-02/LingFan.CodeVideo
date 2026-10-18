import type { Ms } from "../shared/units";
import type { Handle, KillOptions, Scheduler } from "../scheduler";
import type { FrameState } from "../feedback";
import type { AudioClip, AudioHandle, AudioOptions, SynthSpec } from "../audio";
import type { AudioGraphEnv } from "../audio/graph";
import type { InputSnapshot } from "../input";
import type { CanvasEnv, Scene } from "./entities";
import type { RandomStream } from "./random";

/** 运行期随机能力：每个单元实例一条独立子流（同 seed + 同调用序列 = 同结果） */
export interface RandomEnv {
  /** 本单元实例的独立随机子流 */
  readonly random: RandomStream;
}

/** 运行期音频能力：与 step/loop/spawn 同为上下文方法（能力即上下文，无全局单例） */
export interface AudioEnv {
  /**
   * 立刻发声并返回句柄；寿命 = 源播完 / stop() / 总时间线尾。
   * @param clip 经 clip() 构造的音频片段
   * @param options 增益、包络、循环、变速与总线；缺省全取默认
   */
  audio(clip: AudioClip, options?: AudioOptions): AudioHandle;
  /**
   * 程序化音源：不依赖素材文件，按参数合成并立刻发声。
   * @param spec 波形、频率、包络、时长等合成参数
   */
  synth(spec: SynthSpec): AudioHandle;
}

/**
 * step 回调：返回 FrameState 即发布状态（经 key 化聚合合并），返回 void 无状态发布。
 * ctx 为本采样点的上下文。
 */
export type StepFn = (ctx: StepContext) => FrameState | void;

/** step 选项：at/after/hold + fps（本单元采样密度；缺省继承） */
export interface StepOptions {
  /** 本段起点（时间线毫秒）；缺省 = 当前 cursor */
  at?: Ms;
  /** 相对当前 cursor 的额外推进（毫秒）；编译器目前只消费 `at`，此字段原样保留 */
  after?: Ms;
  /** 结束后保留最后一帧到本段收窗；缺省 false */
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
  /** 是否处于消亡窗口（窗口内继续逐帧求值） */
  readonly disposing: boolean;
  /** 消亡进度 0→1；未进入消亡窗口时恒 0 */
  readonly disposeProgress: number;
  /** 触发自己的消亡（缺省立即死；fadeOut 给消失过程） */
  dispose(options?: KillOptions): void;
}

/**
 * 事件去重作用域：音频发射永远是事件，缺的只是「同一作用域只发一次」的原语。
 * - unit：该 step/loop 单元（含 loop 的全部迭代）只发一次（缺省）；
 * - iteration：loop 内容每轮一次（画面回卷时音效跟着每轮响）；
 * - spawn：每个 spawn 实例一次（key 作实例 id）；
 * - scene：整场一次（如开场提示音）。
 */
export type OnceScope = "scene" | "spawn" | "iteration" | "unit";

/** 去重回调的能力集：只给发声与自消杀（去重的语义是「事件」，不是「产帧」） */
export interface OnceContext {
  /** 发声函数，语义同 AudioEnv.audio */
  readonly audio: AudioEnv["audio"];
  /** 自消杀函数，语义同 Disposal.dispose */
  readonly dispose: Disposal["dispose"];
}

/** 去重回调：每个作用域至多执行一次，只做事件（发声/自消杀），不产帧 */
export type OnceFn = (ctx: OnceContext) => void;

/** 事件去重能力：`ctx.once(fn)` = unit 作用域；`ctx.once(scope, fn)` 显式指定 */
export interface OnceEnv {
  /**
   * 在当前作用域内只执行一次 fn（缺省 unit 作用域）。
   * @param fn 去重回调
   */
  once(fn: OnceFn): void;
  /**
   * 在指定作用域内只执行一次 fn。
   * @param scope 去重作用域
   * @param fn 去重回调
   */
  once(scope: OnceScope, fn: OnceFn): void;
}

/** step 回调的能力集：绘制、发声、总线、自消杀、去重与随机；`step` 消耗帧窗池并推进 cursor */
export interface StepContext
  extends CanvasEnv, AudioEnv, AudioGraphEnv, Disposal, OnceEnv, RandomEnv {
  /** 本采样点的全局时间线时刻（毫秒） */
  t: Ms;
  /** 本采样点的全局帧号（0 起） */
  frameIndex: number;
  /** 整条时间线总时长（毫秒） */
  totalTime: Ms;
  /** 本帧时刻的输入快照（atMs ≤ t 的事件已生效；同帧所有单元共享） */
  input: InputSnapshot;
  /** 本单元有效帧率（单元声明 > spawn 链 > 基础） */
  fps: number;
  /** = 1000 / 本单元有效帧率 */
  deltaTime: Ms;
  /** 本单元内的本地时间（毫秒）：从本段起点算起 */
  localT: Ms;
  /** 本单元时长（毫秒） */
  duration: Ms;
  /** 0..1，= localT / duration */
  progress: number;
  /**
   * 开一条并行的 spawn 链。
   * @param scene 要并行推演的场景
   * @param options key 必填（同 key 去重 = 跨段续接）
   * @returns 可 kill 的实例句柄
   */
  spawn: <S>(scene: Scene<S>, options: SpawnOptionsLike) => Handle;
  /** 生命周期门面：按 key/id 消杀 */
  scheduler: Scheduler;
}

/** 避免与 entities 循环引用的窄化别名（结构与 SpawnOptions 一致） */
export type SpawnOptionsLike = {
  /** 实例键：同 key 去重 = 跨段续接 */
  key: string;
  /** 相对登记位置的起播偏移（毫秒）；缺省 = 登记处 */
  at?: Ms;
  /** 实例时长（毫秒）；缺省 = 场景自身时长 */
  duration?: Ms;
  /** 寿命铺到总时间线尾，或显式 kill() */
  forever?: boolean;
  /** 整条链的基础采样密度（链内单元未声明 fps 时继承） */
  fps?: number;
};

/**
 * wait 回调：不产帧，只在「同一时刻有别的活跃单元在产帧」的网格点上被调用。
 * ctx 为该网格点的上下文。
 */
export type WaitFn = (ctx: WaitContext) => void;

/** wait 选项：可消杀名（与 step/loop 同一套具名消杀） */
export interface WaitOptions {
  /** 可消杀名：`scheduler.kill(id)` 按名字找得到这个单元（缺省 = 编译键） */
  id?: string;
}

/**
 * wait 回调上下文。
 * 能力集刻意**不含** canvas / step / loop / spawn / par：这段不产帧，
 * 若能画、能开新的产帧路径，「空窗不产帧」的导出优化就失真了。
 * 需要画东西的段落用 step（会产帧）。
 */
export interface WaitContext
  extends AudioEnv, AudioGraphEnv, Disposal, OnceEnv, RandomEnv {
  /** 全局时间线时刻（毫秒） */
  t: Ms;
  /** 全局帧号（0 起） */
  frameIndex: number;
  /** 整条时间线总时长（毫秒） */
  totalTime: Ms;
  /** 本时刻的输入快照（与同帧产帧单元拿到的同一份） */
  input: InputSnapshot;
  /** wait 窗内偏移（毫秒） */
  localT: Ms;
  /** wait 段时长（毫秒） */
  duration: Ms;
  /** 0..1，= localT / duration */
  progress: number;
  /** 生命周期门面：按 key/id 消杀 */
  scheduler: Scheduler;
}

/** loop 统一对象参数：省略 ms = 无固定迭代窗（fn 自管 next()/stop() 推进节奏） */
export interface LoopSpec {
  /** 每轮迭代窗口（毫秒）；省略 = 无固定迭代窗 */
  ms?: Ms;
  /** 迭代次数上限；省略 = 不按次数停（铺到时间线尾或被 stop()） */
  times?: number;
  /** 每轮迭代体：可绘制、发声、推进到下一轮 */
  fn: (ctx: LoopContext) => void;
  /** 本 loop 采样密度（缺省 = 继承） */
  fps?: number;
  /** 可消杀名：scheduler.kill(id) 按名字找得到这个循环（缺省 = 编译键） */
  id?: string;
}

/** loop 回调的能力集：同 step，但 loop 后台并行、不推进父 cursor，靠 `next()`/`stop()` 自管节奏 */
export interface LoopContext
  extends CanvasEnv, AudioEnv, AudioGraphEnv, Disposal, OnceEnv, RandomEnv {
  /** 父级时间线时刻（毫秒） */
  parentT: Ms;
  /** 全局帧号（0 起） */
  frameIndex: number;
  /** 本帧时刻的输入快照（atMs ≤ t 的事件已生效；同帧所有单元共享） */
  input: InputSnapshot;
  /** 本单元有效帧率（单元声明 > spawn 链 > 基础） */
  fps: number;
  /** = 1000 / 本单元有效帧率 */
  deltaTime: Ms;
  /** 当前迭代序号（0 起） */
  iteration: number;
  /** 当前迭代内偏移（毫秒） */
  iterationT: Ms;
  /** 0..1，= iterationT / ms（无 ms 时无意义，恒 0） */
  iterationProgress: number;
  /** 推进到下一轮迭代 */
  next(): void;
  /** 结束本 loop */
  stop(): void;
  /**
   * 开一条并行的 spawn 链。
   * @param scene 要并行推演的场景
   * @param options key 必填（同 key 去重 = 跨段续接）
   * @returns 可 kill 的实例句柄
   */
  spawn: <S>(scene: Scene<S>, options: SpawnOptionsLike) => Handle;
  /** 生命周期门面：按 key/id 消杀 */
  scheduler: Scheduler;
}
