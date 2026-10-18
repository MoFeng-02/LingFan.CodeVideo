import type { Ms } from "../shared/units";
import type { Handle, SpawnOptions } from "../scheduler";
import type { AssetSource } from "../asset";
import type {
  AudioClip,
  AudioOptions,
  BusAutomationSpec,
  BusSpec,
  DuckRule,
  SendSpec,
  SynthSpec,
} from "../audio";
import type {
  LoopSpec,
  StepFn,
  StepOptions,
  WaitFn,
  WaitOptions,
} from "./nodes";

/** 帧号换算糖：f(n) = n × (1000 / 单元有效帧率)——单元内语义，跨单元不可比 */
export type FrameFn = (frameNumber: number) => Ms;

/** 画布环境（登记与逐帧上下文共享的部分） */
export interface CanvasEnv {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  f: FrameFn;
}

/**
 * 登记阶段环境。
 * 设计决定：step/loop/par/wait/transitionTo 以 SceneEnv 成员形式提供——
 * 显式上下文、避免隐式注册作用域。
 */
export interface SceneEnv extends CanvasEnv {
  fps: number;
  headless: boolean;
  /** 显式时长形式 */
  step(duration: Ms, fn: StepFn, options?: StepOptions): void;
  /** 默认时长形式（单帧；检查时机 = 契约符合性检查） */
  step(fn: StepFn, options?: StepOptions): void;
  /** loop 统一对象参数 {ms?, times?, fn} */
  loop(spec: LoopSpec): void;
  /** 分支显式接分支 env（闭包捕获外层 env 不构成分支） */
  par(children: Array<(branch: SceneEnv) => void>): void;
  /** key 必填（同 key 去重 = 跨段续接） */
  spawn<S>(scene: Scene<S>, options: SpawnOptions): Handle;
  /** 纯时间推进（自身不产帧）；给 onUpdate 则「有帧时逐帧回调」 */
  wait(duration: Ms, onUpdate?: WaitFn, options?: WaitOptions): void;
  transitionTo(next: Scene<unknown>): void;
  /**
   * 登记期音频声明：起点 = 登记位置 + at；不消耗帧窗池、不改 step 模型。
   * 运行期发声与操作走 StepContext/LoopContext.audio（拿 AudioHandle）。
   */
  audio(clip: AudioClip, options?: AudioOptions): void;
  /** bgm 糖：缺省循环到时间线尾（显式 loop 可覆盖） */
  bgm(clip: AudioClip, options?: Omit<AudioOptions, "loop">): void;
  /** 程序化音源：按参数合成，起点 = 当前登记位置；返回 void（与 audio 一致） */
  synth(spec: SynthSpec): void;
  /**
   * 登记期总线拓扑：建 bus、挂父总线下；重复登记同 id = 覆盖规格（最后声明为准）。
   * 拓扑（父子关系）只在这里定；运行期走 ctx.bus(id) 改参数。
   */
  bus(spec: BusSpec): void;
  /** 登记一条发送（from → to，amount 静音比例） */
  send(spec: SendSpec): void;
  /** 登记一条侧链压制（from 起声时压低 to；确定性 DSP 在混音器里跑） */
  duck(rule: DuckRule): void;
  /**
   * 登记期总线自动化计划：把参数轨迹写成数据（不占帧窗池）。
   * 时刻相对本段起点；到点生效，缺省立即、rampMs 线性过渡。
   * 与 `ctx.bus(id).gain/pan` 同一套参数面：声明是计划，运行期句柄是即时改写。
   */
  automate(spec: BusAutomationSpec): void;
}

/**
 * setup 阶段环境：资产加载同位进 setup；run 阶段拿不到 assets。
 *
 * 资产种类与载荷由 `AssetSource` 一侧声明（`asset/entities`），这里只引用，不重复定义。
 */
export interface SetupEnv extends SceneEnv {
  assets: AssetSource;
}

/** 剧本片段：不可变链，cutTo 返回新片段 */
export interface Scene<P = unknown> {
  readonly id: string;
  readonly duration: Ms;
  /** body 显式接上一幕状态；返回值成为下一幕 params */
  cutTo<N>(windowMs: Ms, body: (prev: P, env: SceneEnv) => N | void): Scene<N>;
  /** 秒糖重载：首参字面量 0 标记秒单位 */
  cutTo<N>(
    _: 0,
    windowSec: number,
    body: (prev: P, env: SceneEnv) => N | void,
  ): Scene<N>;
}

/** start 签名：body 返回 P | void（返回值成为下一幕 params） */
export interface StartFn {
  <P>(windowMs: Ms, body: (env: SceneEnv) => P | void): Scene<P>;
  <P>(_: 0, windowSec: number, body: (env: SceneEnv) => P | void): Scene<P>;
  <P>(spec: StartSpec<P>): Scene<P>;
}

/** spec 形式：setup 只跑一次（资产/解码），run 为登记体 */
export interface StartSpec<P> {
  window: Ms;
  /**
   * setup 在推演开始前跑一次：资产加载与解码都放这里。
   *
   * 可以返回 Promise——引擎会等它完成再构建时间线，因此帧序列仍然确定
   * （等待发生在第一帧求值之前，不参与任何帧的时序）。
   * 例外：运行期 `ctx.spawn` 的场景在帧内编译，不能等待 I/O；这类场景的 setup 必须是同步的，
   * 否则引擎明确报 `spec_violation`。
   */
  setup?: (env: SetupEnv) => void | Promise<void>;
  run: (env: SceneEnv) => P | void;
}
