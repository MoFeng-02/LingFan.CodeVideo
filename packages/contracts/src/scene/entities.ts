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
import type { LayerEnv } from "./layers";

/**
 * 帧号换算糖：f(n) = n × (1000 / 单元有效帧率)——单元内语义，跨单元不可比。
 * frameNumber 为单元内帧号（0 起）。
 */
export type FrameFn = (frameNumber: number) => Ms;

/** 画布环境（登记与逐帧上下文共享的部分） */
export interface CanvasEnv {
  /** 绘制目标：2D 适配器直接画到它；DOM 画布或离屏画布 */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** 画布宽（像素） */
  width: number;
  /** 画布高（像素） */
  height: number;
  /** 帧号换毫秒：n 帧 = n × (1000 / 本单元有效帧率) */
  f: FrameFn;
}

/**
 * 过场选项。缺省 = 硬切：本段在 anchor 收窗、下一段从 anchor 开始，任何时刻只有一段活跃。
 * 给了 overlapMs = 重叠窗：下一段提前 overlapMs 开始，窗口内两段同时求值、下一段后绘制。
 * 两段共享这段时长是唯一的代价（总长 = 两段之和 − overlap），换来真正的叠化/擦除——
 * 不需要任何一段画遮盖，也不需要绝对时间对齐。
 */
export interface TransitionOptions {
  /**
   * 重叠时长（毫秒）：必须 > 0、不大于本段收窗长度、不大于下一段长度。
   * 重叠窗内两段各自按自己的本地时间推进（下一段 localT 从 0 开始）。
   */
  readonly overlapMs?: Ms;
}

/**
 * 登记阶段环境。
 * 设计决定：step/loop/par/wait/transitionTo 以 SceneEnv 成员形式提供——
 * 显式上下文、避免隐式注册作用域。
 */
export interface SceneEnv extends CanvasEnv, LayerEnv {
  /** 本段基础采样密度（帧/秒）；单元未声明 fps 时按它走 */
  fps: number;
  /** 是否无呈现出片：不建显示面、只求值与编码 */
  headless: boolean;
  /**
   * 登记一段占固定时长的 step。
   * @param duration 本段时长（毫秒）
   * @param fn 逐采样点回调
   * @param options 起点、保留、采样密度与可消杀名
   */
  step(duration: Ms, fn: StepFn, options?: StepOptions): void;
  /**
   * 登记一段单帧 step（时长 = 一个采样步）。
   * @param fn 逐采样点回调
   * @param options 起点、保留、采样密度与可消杀名
   */
  step(fn: StepFn, options?: StepOptions): void;
  /**
   * 登记一个循环。
   * @param spec 迭代窗、迭代次数、回调与采样密度
   */
  loop(spec: LoopSpec): void;
  /**
   * 登记并行分支：各分支共享同一段时间线，可各自声明自己那一层。
   * @param children 分支登记体（显式接分支 env）
   */
  par(children: Array<(branch: SceneEnv) => void>): void;
  /**
   * 开一条 spawn 链。
   * @param scene 要并行推演的场景
   * @param options key 必填（同 key 去重 = 跨段续接）
   * @returns 可 kill 的实例句柄
   */
  spawn<S>(scene: Scene<S>, options: SpawnOptions): Handle;
  /**
   * 纯时间推进（自身不产帧）；给 onUpdate 则「有帧时逐帧回调」。
   * @param duration 推进时长（毫秒）
   * @param onUpdate 有帧时的逐采样点回调；不产帧的窗内不调用
   * @param options 可消杀名
   */
  wait(duration: Ms, onUpdate?: WaitFn, options?: WaitOptions): void;
  /**
   * 登记一个过场：把时间线交给下一幕。
   * @param next 下一幕场景
   * @param options 重叠窗等过场选项
   */
  transitionTo(next: Scene<unknown>, options?: TransitionOptions): void;
  /**
   * 登记期音频声明：起点 = 登记位置 + at；不消耗帧窗池、不改 step 模型。
   * 运行期发声与操作走 StepContext/LoopContext.audio（拿 AudioHandle）。
   * @param clip 经 clip() 构造的音频片段
   * @param options 增益、包络、循环、变速与总线
   */
  audio(clip: AudioClip, options?: AudioOptions): void;
  /**
   * bgm 糖：缺省循环到时间线尾（显式 loop 可覆盖）。
   * @param clip 经 clip() 构造的音频片段
   * @param options 除 loop 外的音频选项
   */
  bgm(clip: AudioClip, options?: Omit<AudioOptions, "loop">): void;
  /**
   * 程序化音源：按参数合成，起点 = 当前登记位置；返回 void（与 audio 一致）。
   * @param spec 波形、频率、包络、时长等合成参数
   */
  synth(spec: SynthSpec): void;
  /**
   * 登记期总线拓扑：建 bus、挂父总线下；重复登记同 id = 覆盖规格（最后声明为准）。
   * 拓扑（父子关系）只在这里定；运行期走 ctx.bus(id) 改参数。
   * @param spec 总线 id、父总线、静态参数与效果链
   */
  bus(spec: BusSpec): void;
  /**
   * 登记一条发送。
   * @param spec from → to 与发送量
   */
  send(spec: SendSpec): void;
  /**
   * 登记一条侧链压制。
   * @param rule from 起声时压低 to 的规则
   */
  duck(rule: DuckRule): void;
  /**
   * 登记期总线自动化计划：把参数轨迹写成数据（不占帧窗池）。
   * 时刻相对本段起点；到点生效，缺省立即、rampMs 线性过渡。
   * 与 `ctx.bus(id).gain/pan` 同一套参数面：声明是计划，运行期句柄是即时改写。
   * @param spec 总线与参数点表
   */
  automate(spec: BusAutomationSpec): void;
}

/**
 * setup 阶段环境：资产加载同位进 setup；run 阶段拿不到 assets。
 *
 * 资产种类与载荷由 `AssetSource` 一侧声明（`asset/entities`），这里只引用，不重复定义。
 */
export interface SetupEnv extends SceneEnv {
  /** 资产来源：只能在这里加载，run 阶段拿不到 */
  assets: AssetSource;
}

/** 剧本片段：不可变链，cutTo 返回新片段 */
export interface Scene<P = unknown> {
  /** 场景唯一标识（错误与诊断里用于定位） */
  readonly id: string;
  /** 本幕时长（毫秒） */
  readonly duration: Ms;
  /**
   * 追加下一幕。
   * @param windowMs 本幕时长（毫秒）
   * @param body 承接上一幕 params 的登记体；返回值成为下一幕 params
   */
  cutTo<N>(windowMs: Ms, body: (prev: P, env: SceneEnv) => N | void): Scene<N>;
  /**
   * 秒糖重载：首参字面量 0 标记秒单位。
   * @param _ 固定 0，标记后续时长单位为秒
   * @param windowSec 本幕时长（秒）
   * @param body 承接上一幕 params 的登记体；返回值成为下一幕 params
   */
  cutTo<N>(
    _: 0,
    windowSec: number,
    body: (prev: P, env: SceneEnv) => N | void,
  ): Scene<N>;
}

/** start 签名：body 返回 P | void（返回值成为下一幕 params） */
export interface StartFn {
  /**
   * @param windowMs 首幕时长（毫秒）
   * @param body 首幕登记体；返回值成为下一幕 params
   */
  <P>(windowMs: Ms, body: (env: SceneEnv) => P | void): Scene<P>;
  /**
   * 秒糖重载：首参字面量 0 标记秒单位。
   * @param _ 固定 0，标记后续时长单位为秒
   * @param windowSec 首幕时长（秒）
   * @param body 首幕登记体；返回值成为下一幕 params
   */
  <P>(_: 0, windowSec: number, body: (env: SceneEnv) => P | void): Scene<P>;
  /**
   * spec 形式。
   * @param spec 时长、setup 与 run
   */
  <P>(spec: StartSpec<P>): Scene<P>;
}

/** spec 形式：setup 只跑一次（资产/解码），run 为登记体 */
export interface StartSpec<P> {
  /** 首幕时长（毫秒） */
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
  /** 首幕登记体；返回值成为下一幕 params */
  run: (env: SceneEnv) => P | void;
}
