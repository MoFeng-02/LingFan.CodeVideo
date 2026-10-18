/**
 * 剧本 DSL 与登记器：把声明式写法捕获成登记期节点流。
 *
 * 两种入口：`createScene` 造片段（链式 `cutTo` 接下一段）、`startScene` 造链头
 * （按窗口长度 + body 形式调用）。`Recorder` 实现 `SceneEnv`，是登记期唯一的状态面：
 * 它只记录节点与推进游标，不做渲染、不碰平台 API，因此同一剧本可被校验、预览、出片共用。
 *
 * 游标语义：`cursor` 是「本段内的登记位置」，只有 `step`/`wait`/`par` 推进它；
 * `loop`/`spawn`/`transition`/`audio`/`synth`/`bus`/`send`/`duck`/`automate`/`layer`
 * 只记锚点（同位置可叠放多条声明），绝对化交给编译期。
 */
import type {
  AudioClip,
  AudioOptions,
  BusAutomationSpec,
  BusSpec,
  DuckRule,
  LayerDeclaration,
  LoopSpec,
  Ms,
  Scene,
  SceneEnv,
  SendSpec,
  SpawnOptions,
  StartSpec,
  StepFn,
  StepOptions,
  SynthSpec,
  TransitionOptions,
  WaitFn,
  WaitOptions,
} from "@lingfan-video/contracts";
import { assertAutomation, assertSynth, loop as loopUntil } from "../audio";
import { violation } from "../spec-violation";
import type { SceneInternal, SimNode } from "./types";

let sceneSeq = 0;

/**
 * 造一个剧本片段（链节点）：登记体在推演开始时被调用一次，捕获出节点流。
 *
 * 返回值的 `cutTo` 在运行时挂载，支持毫秒与秒两种写法；一个片段只能有一个出口，
 * 重复链接会抛 `spec_violation`。两种 body 形状都收：不读上一幕就只接 env
 * （spawn/cutTo 目标的常见写法），需要上一幕状态时显式写 `(prev, env)`。
 *
 * @param duration 段窗口长度（毫秒）：总毫秒池的一段，也是内容窗口的上界
 * @param body 登记体：拿上一幕状态与 SceneEnv，把节点登记进 Recorder
 * @param setup 可选的一次性准备（资产加载/解码），在登记前跑，可返回 Promise
 * @returns 片段运行时形态（id 自动生成，同一进程内递增）
 */

export function createScene<P>(
  duration: Ms,
  body: (prev: P, env: SceneEnv) => unknown,
  setup?: SceneInternal<P>["setup"],
): SceneInternal<P> {
  const id = `scene#${sceneSeq++}`;
  const scene = { id, duration, body, setup } as SceneInternal<P>; // cutTo 挂载前先断言（方法由下方补齐）
  (scene as { cutTo?: unknown }).cutTo = ((...args: unknown[]) => {
    // (windowMs, body) 或 (_, 0, windowSec, body)
    let windowMs: Ms;
    let childBody: (prev: unknown, env: SceneEnv) => unknown;
    if (args.length === 3) {
      windowMs = (args[1] as number) * 1000;
      childBody = args[2] as (prev: unknown, env: SceneEnv) => unknown;
    } else {
      windowMs = args[0] as Ms;
      childBody = args[1] as (prev: unknown, env: SceneEnv) => unknown;
    }
    if (scene.next)
      throw new Error(
        `spec_violation: ${id} 重复链接（cutTo/transitionTo 只能一个出口）`,
      );
    const child = createScene(windowMs, childBody);
    scene.next = child;
    return child as unknown as Scene<unknown>;
  }) as unknown;
  return scene;
}

/**
 * 登记器：把 SceneEnv 调用捕获为 SimNode 流。
 * cursor 只被 step/wait/par 推进；loop/spawn/transition/audio 不推进 cursor。
 */
export class Recorder implements SceneEnv {
  /** 登记下来的节点流（编译期输入；顺序 = 登记顺序） */
  readonly nodes: SimNode[] = [];
  /** 段内登记位置（毫秒）：只被 step/wait/par 推进 */
  cursor: Ms = 0;
  /** 单元序：每登记一个单元加一；同一循环的多次迭代共用同一个序值 */
  order = 0;
  /** 帧号 → 毫秒：`f(n) = n × 1000 / fps`，只在单元内有效，跨单元不可比 */
  readonly f: SceneEnv["f"];

  /**
   * @param width 逻辑画布宽度（像素）：只作为登记期上下文，不参与时间计算
   * @param height 逻辑画布高度（像素）：同上
   * @param fps 本登记器的采样密度（帧/秒）：`f()` 换算与 step 缺省时长用它
   * @param headless 是否无画布推演（校验/服务器出片时为 true）
   * @param canvas 画布句柄（headless 时为 null）
   */
  constructor(
    readonly width: number,
    readonly height: number,
    readonly fps: number,
    readonly headless: boolean,
    readonly canvas: SceneEnv["canvas"],
  ) {
    this.f = (n: number) => (n * 1000) / fps;
  }

  /**
   * 登记一个逐帧求值单元，并推进游标。
   *
   * 两种写法：函数形式 `step(fn, options?)` 的时长缺省为一帧；数字形式
   * `step(ms, fn, options?)` 显式给窗口毫秒。单元只在窗口内求值，窗后退出。
   *
   * @param a 函数形式传逐帧回调；数字形式传窗口长度（毫秒，须非负）
   * @param b 函数形式时是选项；数字形式时是逐帧回调
   * @param c 仅数字形式使用：选项（fps/id/hold/at 等）
   */
  step(a: StepFn | Ms, b?: StepFn | StepOptions, c?: StepOptions): void {
    let node: Extract<SimNode, { kind: "step" }>;
    if (typeof a === "function") {
      const opts = (b ?? {}) as StepOptions;
      // 默认时长 = 声明帧率下的一帧（未声明 = 基础帧率一帧）
      const fps = opts.fps ?? this.fps;
      node = { kind: "step", duration: 1000 / fps, fn: a, ...opts };
    } else {
      const opts = (c ?? {}) as StepOptions;
      node = { kind: "step", duration: a, fn: b as StepFn, ...opts };
    }
    this.nodes.push(node);
    this.cursor += node.duration;
  }

  /**
   * 登记一个循环（不推进游标：迭代在后台并行推进）。
   *
   * 给了 `ms` 是固定迭代窗；省略 `ms` 是自管节奏，由回调里的 `next()`/`stop()` 驱动。
   * 循环之后的节点仍从当前登记位置起算。
   *
   * @param spec 循环参数：ms/times/fps/id/fn（见 LoopSpec）
   */
  loop(spec: LoopSpec): void {
    this.nodes.push({
      kind: "loop",
      ms: spec.ms,
      times: spec.times,
      fps: spec.fps,
      id: spec.id,
      fn: spec.fn,
    });
  }

  /**
   * 登记一组并行分支，并把游标推进「各分支终点的最大值」。
   *
   * 每个分支拿到独立的登记器（共享起点、各自推进）；分支必须使用传入的分支 env，
   * 直接闭包捕获外层 env 不构成分支。分支之间互不等待，池消耗取最长分支。
   *
   * @param children 分支列表：每个元素拿到自己的分支 env 去登记节点
   */
  par(children: Array<(branch: SceneEnv) => void>): void {
    // 子作用域共享起点、各自推进；一个 par 节点带分支列表，池消耗 = max
    const subs = children.map(
      () =>
        new Recorder(
          this.width,
          this.height,
          this.fps,
          this.headless,
          this.canvas,
        ),
    );
    children.forEach((thunk, i) => thunk(subs[i]!)); // 分支 env 显式传入（闭包捕获外层 env 不构成分支）
    let pool: Ms = 0;
    for (const sub of subs) pool = Math.max(pool, sub.cursor);
    this.nodes.push({ kind: "par", children: subs.map((s) => s.nodes) });
    this.cursor += pool;
  }

  /**
   * 登记一条嵌入剧本链（不推进游标；起点 = 当前登记位置 + `options.at`）。
   *
   * 返回的是**占位句柄**：登记期还没有运行实例，`kill`/`dispose` 不做事，
   * `alive` 恒为 false、`localTime`/`duration` 恒为 0。真正的运行句柄来自
   * 逐帧回调拿到的 `ctx.spawn`。同 `key` 视为同一实例（跨段续接）。
   *
   * @param scene 被嵌入的链头剧本（链上 next 会被顺链计入时长）
   * @param options 登记期选项：key 必填；at/duration/forever/fps 见 SpawnOptions
   * @returns 占位句柄（登记期无运行实例）
   */
  spawn<S>(
    scene: Scene<S>,
    options: SpawnOptions,
  ): import("@lingfan-video/contracts").Handle {
    this.nodes.push({
      kind: "spawn",
      scene: scene as Scene<unknown>,
      options,
      anchor: this.cursor,
    });
    // 登记期无运行句柄（占位 Handle；运行期句柄来自 StepContext.spawn）
    return {
      kill() {},
      dispose() {},
      get alive() {
        return false;
      },
      localTime: 0,
      duration: 0,
    };
  }

  /**
   * 登记一段纯时间推进（不产帧），并推进游标。
   *
   * 只推进时间、不画东西；给了 `onUpdate` 时会在「其他单元产帧的网格点」上被回调，
   * 因此它本身不参与采样网格。适合「等一段时间但保持声音/控制仍响应」的写法。
   *
   * @param duration 推进时长（毫秒，须非负）
   * @param onUpdate 可选逐帧回调：拿 WaitContext，能发声、能消杀，但不能画
   * @param options 可选选项：id（可消杀名）
   */
  wait(duration: Ms, onUpdate?: WaitFn, options?: WaitOptions): void {
    this.nodes.push({ kind: "wait", duration, onUpdate, id: options?.id });
    this.cursor += duration;
  }

  /**
   * 登记「接下一段」的过场：把当前时刻记为提前收窗点（anchor），其后节点不再活跃。
   *
   * `overlapMs` 省略 = 硬切；给了必须是 > 0 的有限毫秒数，且不能吃满整段收窗长度
   * （编译期会抛 `spec_violation`）。真正的链接由编译产物透出、运行期链式推进。
   *
   * @param next 下一段剧本
   * @param options 可选：overlapMs（重叠窗，毫秒）
   */
  transitionTo(next: Scene<unknown>, options?: TransitionOptions): void {
    const overlapMs = options?.overlapMs;
    if (
      overlapMs !== undefined &&
      (!Number.isFinite(overlapMs) || overlapMs <= 0)
    )
      throw violation(
        `transitionTo 的 overlapMs 必须是 > 0 的有限毫秒数（收到 ${overlapMs}）`,
      );
    // 只登记 anchor（提前收窗点）与重叠窗；next 的链接语义由 compile 消费
    this.nodes.push({
      kind: "transition",
      next,
      anchor: this.cursor,
      ...(overlapMs === undefined ? {} : { overlapMs }),
    });
  }

  /**
   * 登记一条音频声明（不推进游标）：起点 = 当前登记位置 + `options.at`。
   *
   * 登记期只记「播什么、什么时候、怎么播」；音量/摆位等运行期操作面在 `ctx.audio`。
   *
   * @param clip 片段：url 指向 setup 阶段预解码的资产
   * @param options 播放选项（增益/摆位/循环/变速/总线）；缺省为空选项
   */
  audio(clip: AudioClip, options?: AudioOptions): void {
    // 登记期是「声明」：起点 = 当前登记位置 + at；运行期操作面在 ctx.audio
    this.nodes.push({
      kind: "audio",
      clip,
      options: options ?? {},
      anchor: this.cursor,
    });
  }

  /**
   * 登记一条画面层声明（不推进游标）：可见区间 = 当前登记位置 + `from`/`to`。
   *
   * 叠放次序由 `z` 决定，因此并行分支各自登记也不会打架。构造期校验：`id` 非空、
   * `from`/`to` 是有限毫秒、给了两端时 `to > from`（空区间直接抛错）。
   *
   * @param declaration 层声明：id（配对键，必填非空）、z/blend、from/to（段内相对毫秒）
   */
  layer(declaration: LayerDeclaration): void {
    // 层声明：不推进 cursor（与 audio/synth 同为声明）。叠放次序由 z 决定，
    // 所以并行分支各自登记也不会打架；同 id 重复登记 = 后者覆盖（编译期收口）。
    if (declaration.id.trim() === "")
      throw violation("layer 的 id 不能为空串：它是剧本与宿主之间唯一的配对键");
    if (declaration.from !== undefined && !Number.isFinite(declaration.from))
      throw violation(`layer "${declaration.id}" 的 from 必须是有限毫秒数`);
    if (declaration.to !== undefined && !Number.isFinite(declaration.to))
      throw violation(`layer "${declaration.id}" 的 to 必须是有限毫秒数`);
    if (
      declaration.from !== undefined &&
      declaration.to !== undefined &&
      declaration.to <= declaration.from
    )
      throw violation(
        `layer "${declaration.id}" 的可见区间为空（to ${declaration.to} <= from ${declaration.from}）`,
      );
    this.nodes.push({
      kind: "layer",
      declaration,
      anchor: this.cursor,
    });
  }

  /**
   * 背景音乐糖：等价于 `audio(clip, { ...options, loop: 到时间线尾 })`。
   *
   * 适合「整段循环铺底」；要定制循环区间就用 `audio` + `loop(untilMs)`。
   *
   * @param clip 片段：url 指向 setup 阶段预解码的资产
   * @param options 除 loop 之外的播放选项（循环区间由本方法固定）
   */
  bgm(clip: AudioClip, options?: Omit<AudioOptions, "loop">): void {
    // bgm 糖：循环到时间线尾（要定制循环区间请用 audio + loop(untilMs)）
    this.audio(clip, { ...options, loop: loopUntil() });
  }

  /**
   * 登记一条程序化音源声明（不推进游标）：起点 = 当前登记位置（无 at 选项）。
   *
   * 构造期先校验 spec（时长/频率/包络等），样本在运行期由音源求值，不占用音频资产。
   *
   * @param spec 音源规格：波形/时长/频率/包络/总线（见 SynthSpec）
   */
  synth(spec: SynthSpec): void {
    // 程序化音源：起点 = 当前登记位置（与 audio 同为声明，不推进 cursor）
    assertSynth(spec);
    this.nodes.push({ kind: "synth", spec, anchor: this.cursor });
  }

  /**
   * 登记一条总线拓扑声明（不推进游标、不占帧窗池）。
   *
   * @param spec 总线规格（id/父总线/音量等，见 BusSpec）
   */
  bus(spec: BusSpec): void {
    // 拓扑登记：不推进 cursor（与 audio 同为声明，不占帧窗池）
    this.nodes.push({ kind: "bus", spec });
  }

  /**
   * 登记一条发送声明（不推进游标）：把源总线按比例送到目标总线。
   *
   * @param spec 发送规格（源/目标/比例，见 SendSpec）
   */
  send(spec: SendSpec): void {
    this.nodes.push({ kind: "send", spec });
  }

  /**
   * 登记一条侧链压制声明（不推进游标）：源总线起声时压低目标总线。
   *
   * @param rule 压制规则（源/目标/阈值/压缩量等，见 DuckRule）
   */
  duck(rule: DuckRule): void {
    this.nodes.push({ kind: "duck", rule });
  }

  /**
   * 登记一份参数计划（不推进游标、不占帧窗池）：把总线参数轨迹写成数据。
   *
   * 构造期先校验轨迹（总线名非空、时刻严格递增、增益/摆位/斜坡合法）；
   * 时刻相对本段起点，全局化在时间线构建时完成。
   *
   * @param spec 参数计划：bus + points（每点的 atMs 与该点参数）
   */
  automate(spec: BusAutomationSpec): void {
    // 参数计划：把轨迹写成数据（不占帧窗池，时刻相对本段起点）
    assertAutomation(spec);
    this.nodes.push({ kind: "automate", spec });
  }
}

/**
 * 链头描述（spec 形式）：把窗口长度、准备函数与登记体打成一个对象传。
 *
 * 声明在契约层（`StartSpec`），这里只做转发；与 `startScene(windowMs, body)`
 * 的区别只是形状，适合参数化剧本或从配置构造。
 */
export type { StartSpec };

/**
 * 造链头剧本（毫秒形式）：窗口长度 + 只接 env 的登记体。
 *
 * @param windowMs 段窗口长度（毫秒）
 * @param body 登记体：只拿 env（链头没有上一幕状态）
 * @returns 链头片段（可继续 cutTo 接下一段）
 */
export function startScene<P>(
  windowMs: Ms,
  body: (env: SceneEnv) => P | void,
): SceneInternal<P>;
/**
 * 造链头剧本（秒糖重载）：首参固定写 0，窗口按秒解释（内部乘 1000 转毫秒）。
 *
 * @param _ 占位，必须写 0（用于区分秒糖与毫秒重载）
 * @param windowSec 段窗口长度（秒）
 * @param body 登记体：只拿 env
 * @returns 链头片段（可继续 cutTo 接下一段）
 */
export function startScene<P>(
  _: 0,
  windowSec: number,
  body: (env: SceneEnv) => P | void,
): SceneInternal<P>;
/**
 * 造链头剧本（spec 形式）：把窗口、setup、登记体打进一个对象传。
 *
 * @param spec 链头描述：window/setup/run
 * @returns 链头片段（可继续 cutTo 接下一段）
 */
export function startScene<P>(spec: StartSpec<P>): SceneInternal<P>;
/**
 * startScene 的实现：按实参个数分派到上列三种重载。
 *
 * @param args 三重载的实参：`(windowMs, body)` / `(0, windowSec, body)` / `(spec)`
 * @returns 链头片段（可继续 cutTo 接下一段）
 */
export function startScene<P>(...args: unknown[]): SceneInternal<P> {
  if (args.length === 1) {
    const spec = args[0] as StartSpec<P>;
    return createScene<P>(
      spec.window,
      (_prev, env) => spec.run(env),
      spec.setup as SceneInternal<P>["setup"],
    );
  }
  if (args.length === 2) {
    const [windowMs, body] = args as [Ms, (env: SceneEnv) => P | void];
    return createScene<P>(windowMs, (_prev, env) => body(env));
  }
  const [, windowSec, body] = args as [0, number, (env: SceneEnv) => P | void];
  return createScene<P>(windowSec * 1000, (_prev, env) => body(env));
}
