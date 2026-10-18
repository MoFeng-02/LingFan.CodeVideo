/**
 * 模拟域的中间表示与双池账本。
 *
 * 数据沿一条流水线走：剧本 body 在登记期被 `Recorder` 捕获成 `SimNode` 节点流 →
 * `compileSegment` 把节点流展平成以毫秒计的编译产物 → 运行期按编译产物逐帧求值。
 * 本文件只放类型与纯函数，不依赖平台 API，校验、预览、出片三条路径共用同一份定义。
 *
 * 时间语义：毫秒是唯一语义单位，`fps` 只是采样密度（决定网格疏密），不改变时间轴。
 * 双池账本：总毫秒池 = 各段窗口期之和（由引擎链式推进，不在本文件计算）；
 * 本文件只算段内帧窗池。除 `step`/`wait`/`par` 外，节点都只登记锚点、不推进游标。
 */
import type {
  AudioClip,
  AudioOptions,
  BusAutomationSpec,
  BusSpec,
  DuckRule,
  FrameState,
  LayerDeclaration,
  LoopContext,
  Ms,
  Scene,
  SceneEnv,
  SendSpec,
  SetupEnv,
  StepFn,
  SynthSpec,
  WaitContext,
  WaitFn,
} from "@lingfan-video/contracts";

/**
 * 登记期节点树（`SceneEnv` 回调被 `Recorder` 调用后留下的中间表示），按登记顺序排列。
 *
 * 节点只记录「登记位置 + 参数」：除 `step`/`wait`/`par` 外都不推进登记游标，
 * 绝对时间由编译期展平。同一位置可以叠放多条声明（音频、层、拓扑图）。
 */
export type SimNode =
  /**
   * 逐帧求值单元（产帧）：窗口内的采样网格点各调一次回调，返回值按单元键聚合进帧状态。
   */
  | {
      kind: "step";
      /** 窗口长度（毫秒）：窗内逐帧求值，窗后退出 */
      duration: Ms;
      /** 逐帧回调：返回 FrameState 则发布，返回 void 表示本帧不发布 */
      fn: StepFn;
      /** 相对登记位置的偏移（毫秒，可为负，缺省 0）；越窗由校验报 window_overflow */
      at?: Ms;
      /** 窗口结束后是否沿用上一帧状态（参数冻结糖，缺省 false） */
      hold?: boolean;
      /** 本单元采样密度（帧/秒）；缺省继承 spawn 链的链级帧率或引擎基础帧率 */
      fps?: number;
      /** 可消杀名：scheduler.kill(id) 按名定位；缺省 = 编译键 */
      id?: string;
    }
  /**
   * 纯时间推进段：不产帧。给了 onUpdate 时只在「其他单元产帧的网格点」上被回调，
   * 因此它不参与采样网格（空窗不产帧的优化依赖这一点）。
   */
  | {
      kind: "wait";
      /** 推进时长（毫秒）：推进登记游标，窗内不产帧 */
      duration: Ms;
      /** 逐帧回调（可选）：拿 WaitContext，能发声、消杀、读随机，但不能画 */
      onUpdate?: WaitFn;
      /** 可消杀名：scheduler.kill(id) 按名定位；缺省 = 编译键 */
      id?: string;
    }
  /**
   * 循环：给了 `ms` = 固定迭代窗（每轮 `ms` 毫秒，可重复 `times` 次，占帧窗池）；
   * 省略 `ms` = 自管节奏（整段活跃，靠 `ctx.next()` / `ctx.stop()` 推进，不占帧窗池）。
   * 迭代在后台并行推进，不推进其后的登记游标。
   */
  | {
      kind: "loop";
      /** 单轮窗口长度（毫秒）；省略 = 无固定迭代窗（自管节奏） */
      ms?: Ms;
      /** 迭代次数；缺省 Infinity（铺到段尾），有 ms 时按剩余段长夹取 */
      times?: number;
      /** 本循环的采样密度（帧/秒）；缺省继承 */
      fps?: number;
      /** 可消杀名：scheduler.kill(id) 杀掉整个循环（全部迭代）；缺省 = 编译键 */
      id?: string;
      /** 每轮回调：拿 LoopContext，用 next() 进下一轮、stop() 结束本循环 */
      fn: (ctx: LoopContext) => void;
    }
  /**
   * 并行分支组：各分支从同一登记位置出发、各自独立推进；本层推进量 = 分支终点最大值。
   * 分支必须显式接分支 env（闭包捕获外层 env 不构成分支）。
   */
  | {
      kind: "par";
      /** 每个分支一个节点流；分支之间共享起点、互不等待 */
      children: SimNode[][];
    }
  /**
   * 嵌入一条剧本链：key 必填（同 key 视为同一实例 = 跨段续接），运行期按编译产物物化。
   * 不推进登记游标：spawn 与其后的节点共享登记位置。
   */
  | {
      kind: "spawn";
      /** 被嵌入的链头剧本 */
      scene: Scene<unknown>;
      /** 登记期选项：key 必填，at 相对登记位置，forever 与 duration 互斥 */
      options: {
        /** 去重/续接键：同 key 视为同一实例，段内重复由校验报错 */
        key: string;
        /** 相对登记位置的偏移（毫秒，缺省 0） */
        at?: Ms;
        /** 显式寿命覆盖（毫秒）；与 forever 互斥 */
        duration?: Ms;
        /** 活到总时间线尾或显式 kill；缺省 false */
        forever?: boolean;
        /** 整条链的基础采样密度（帧/秒）；缺省继承外层 */
        fps?: number;
      };
      /** 登记位置的游标值（毫秒）：编译期据此算全局锚点 */
      anchor: Ms;
    }
  /**
   * 过场：登记提前收窗点（anchor）与可选的下一段重叠窗；其后节点不活跃。
   * 下一段链接与重叠长度由编译产物透出，运行期链式推进。
   */
  | {
      kind: "transition";
      /** 下一段剧本 */
      next: Scene<unknown>;
      /** 本段收窗点（毫秒）：登记位置，之后的节点不再活跃 */
      anchor: Ms;
      /** 重叠窗（毫秒）：下一段提前这么多开始，窗口内两段同时活跃 */
      overlapMs?: Ms;
    }
  /** 音频声明：起点 = 登记位置 + options.at；不推进游标、不占帧窗池 */
  | {
      kind: "audio";
      /** 片段：url 指向 setup 阶段预解码的资产 */
      clip: AudioClip;
      /** 播放选项（增益/摆位/循环/变速/总线） */
      options: AudioOptions;
      /** 登记位置（毫秒）；编译期与 options.at 相加成段内偏移 */
      anchor: Ms;
    }
  /** 程序化音源声明：起点 = 登记位置（无 at 选项）；不推进游标 */
  | { kind: "synth"; spec: SynthSpec; anchor: Ms }
  /** 参数计划：把总线参数轨迹写成数据，时刻相对本段起点；不推进游标 */
  | { kind: "automate"; spec: BusAutomationSpec }
  /** 总线拓扑声明（建总线 / 挂父总线）；同 id 重复登记由消费方收口 */
  | { kind: "bus"; spec: BusSpec }
  /** 发送声明：把源总线按比例送到目标总线 */
  | { kind: "send"; spec: SendSpec }
  /** 侧链压制声明：源总线起声时压低目标总线 */
  | { kind: "duck"; rule: DuckRule }
  /** 画面层声明：可见区间由 declaration.from/to 决定（段内相对毫秒）；不推进游标 */
  | {
      kind: "layer";
      /** 层声明：id 必须非空，from/to 必须是有限毫秒且 to > from */
      declaration: LayerDeclaration;
      /** 登记位置（毫秒）：编译期与 declaration.from/to 相加成段内偏移 */
      anchor: Ms;
    };

/**
 * 剧本片段的运行时形态：契约 `Scene` 的内部实现。
 *
 * 与契约的差别只在多出来的内部字段（`body`/`next`）。引擎只依赖本接口的字段，
 * 不依赖任何具体实现类，因此剧本可以来自 DSL、也可以是别的构造方式。
 */
export interface SceneInternal<P = unknown> {
  /** 段标识（进程内唯一，由构造顺序生成；用于诊断与聚合键，不参与确定性） */
  readonly id: string;
  /** 段窗口长度（毫秒）：总毫秒池的一段；是上限，本段内容末点可以更早 */
  readonly duration: Ms;
  /** 登记体：拿到上一幕状态与 SceneEnv，把节点登记进 Recorder */
  readonly body: (prev: P, env: SceneEnv) => unknown;
  /**
   * 链式接下一段（毫秒形式）：返回新片段，同时把本段的 next 指过去。
   * 一个片段只能有一个出口，重复调用抛 spec_violation。
   *
   * @param windowMs 下一段窗口长度（毫秒）
   * @param body 下一段登记体：prev 是本段 body 的返回值
   * @returns 下一段的运行时形态（链上节点）
   */
  cutTo<N>(
    windowMs: Ms,
    body: (prev: P, env: SceneEnv) => N | void,
  ): SceneInternal<N>;
  /**
   * cutTo 的秒糖重载：首参固定写 0，`windowSec` 按秒解释（内部乘 1000 转毫秒）。
   *
   * @param _ 占位，必须写 0（用于区分秒糖与毫秒重载）
   * @param windowSec 下一段窗口长度（秒）
   * @param body 下一段登记体
   * @returns 下一段的运行时形态（链上节点）
   */
  cutTo<N>(
    _: 0,
    windowSec: number,
    body: (prev: P, env: SceneEnv) => N | void,
  ): SceneInternal<N>;
  /** setup：推演开始前跑一次（资产加载/解码），可返回 Promise */
  readonly setup?: (env: SetupEnv) => Promise<void> | void;
  /** 链上下一个片段（cutTo 写入；undefined = 链尾） */
  next?: SceneInternal<unknown>;
}

/**
 * 链起点场景的结构面：prev 的类型由调用方剧本决定（void/P/unknown 都行），
 * 引擎从链头开始跑、不消费入参，因此只要求「引擎真正会读的字段」。
 */
export interface SceneEntry {
  /** 段标识（诊断与聚合键用；不参与确定性） */
  readonly id: string;
  /** 段窗口长度（毫秒）：总毫秒池按它累加 */
  readonly duration: Ms;
  /** setup：推演开始前跑一次（资产加载/解码），可返回 Promise */
  readonly setup?: (env: SetupEnv) => Promise<void> | void;
  /** 链上下一个片段（undefined = 链尾） */
  next?: SceneInternal<unknown>;
}

/** 编译产物：窗口内绝对化的一帧活动单元（step 或一次 loop 迭代） */
export interface CompiledUnit {
  /** 编译键（`step#n` / `wait#n` / `loop#n:i`）：段内唯一，聚合键与调试图标用 */
  key: string;
  /** 窗口起点（毫秒，段内相对）：本单元参与求值的最早时刻 */
  windowStart: Ms;
  /** 窗口终点（毫秒，段内相对，右开）：该时刻起不再求值 */
  windowEnd: Ms;
  /** 窗口结束后是否沿用上一帧状态（step 的 hold 糖；其他单元恒 false） */
  hold: boolean;
  /** 本单元有效采样密度（单元声明 > 继承；编译期解析完毕，运行期不再回溯） */
  fps: number;
  /** 回调入参：step 收 StepContext、loop 迭代收 LoopContext（由 runtime 组装） */
  call: (ctx: unknown) => FrameState | void;
  /**
   * wait 回调单元：**不产帧**，只在「其他单元产帧的网格点」上被调用；
   * 出现该字段 = 本单元不贡献采样网格。`call` 为其占位（不发 FrameState）。
   */
  onUpdate?: (ctx: WaitContext) => void;
  /** loop 迭代元数据（step 无） */
  loop?: { iteration: number; iterationMs?: Ms };
  /** loop 单元的宿主锚点（`loop#N`；stop() 按宿主杀全迭代） */
  loopBase?: string;
  /** 可消杀名（scheduler.kill(id) / ctx.dispose() 按名定位；缺省 = 编译键） */
  disposeId?: string;
  /** 源节点序（同帧绘制顺序 = 登记顺序） */
  order: number;
}

/** 编译产物的嵌入链声明（spawn：段内登记、全局锚点） */
export interface CompiledSpawn {
  /** 去重/续接键（与登记期 options.key 同源） */
  key: string;
  /** 链头剧本 */
  scene: Scene<unknown>;
  /** 相对链起点的全局锚点（spawn 在登记流中的 cursor + options.at） */
  startGlobal: Ms;
  /** 链自身总时长（毫秒）：forever 时由父级时间线截断 */
  chainDuration: Ms;
  /** 是否活到总时间线尾或显式 kill */
  forever: boolean;
  /** 链级基础帧率（链内单元未声明 fps 时继承；undefined = 引擎基础帧率） */
  chainFps?: number;
}

/** 编译产物的音频声明（段内相对锚点；全局化与运行期发射由 runtime 承担） */
export interface CompiledAudio {
  /** 片段（synth 声明时只是占位身份） */
  readonly clip: AudioClip;
  /** 段内偏移（毫秒）：登记位置 + options.at */
  atMs: Ms;
  /** 播放选项（增益/摆位/循环/变速/总线） */
  readonly options: AudioOptions;
  /** 程序化音源：有该字段时 clip 只是占位身份 */
  readonly synth?: SynthSpec;
}

/** 编译产物的层声明（段内相对锚点；全局化由 runtime 承担） */
export interface CompiledLayer {
  /** 层声明（id/z/blend 等交给帧宿主解释） */
  readonly declaration: LayerDeclaration;
  /** 段内偏移起点（毫秒）：登记位置 + declaration.from */
  readonly fromMs: Ms;
  /** 段内偏移终点（毫秒）：给了 to 则为登记位置 + to；undefined = 本段收窗 */
  readonly toMs?: Ms;
}

/** 单段编译结果（衔接下一片段由 runtime 链式推进） */
export interface CompiledSegment {
  /** 段标识（诊断与聚合键用） */
  sceneId: string;
  /** 段窗口长度（毫秒）：总毫秒池的一段 */
  duration: Ms;
  /** 窗口内活动单元（step / wait / loop 迭代）：同帧按 order 顺序求值 */
  units: CompiledUnit[];
  /** 嵌入链声明（锚点已全局化） */
  spawns: CompiledSpawn[];
  /** 音频声明（段内相对时刻） */
  audio: CompiledAudio[];
  /** 登记期画面层声明（段内相对时刻；runtime 全局化后交给帧宿主） */
  layers: CompiledLayer[];
  /** 登记期音频图拓扑（段内声明；runtime 汇总成全时间线图） */
  buses: BusSpec[];
  /** 发送声明（段内声明；runtime 汇总成全时间线图） */
  sends: SendSpec[];
  /** 侧链压制声明（段内声明；runtime 汇总成全时间线图） */
  ducks: DuckRule[];
  /** 登记期参数计划（段内相对时刻；runtime 全局化后按时间推进生效） */
  automations: BusAutomationSpec[];
  /** transitionTo 提前收窗（其后节点不活跃）；undefined = 跑满 duration */
  activeEnd?: Ms;
  /** transitionTo 的目标片段（由 compile 从节点流透出，runtime 链式推进用） */
  transitionNext?: unknown;
  /** 过场重叠窗（毫秒）：下一段提前这么多开始；undefined = 硬切 */
  transitionOverlap?: Ms;
  /** body 返回值（成为链上下一幕 body 的 prev 参数） */
  bodyResult: unknown;
}

/**
 * 池消耗账本（段内帧窗池）：把登记期节点流折算成「占用多少毫秒的活跃窗口」。
 *
 * 只有产帧/占池的节点计入：`step`/`wait` 加自己的窗口，`loop` 加迭代窗，
 * `par` 加分支池的最大值（分支并行，取最长的那个而不是求和）；
 * 其余节点只登记锚点，贡献为 0。总毫秒池 = 各段窗口期之和，不在这里算。
 *
 * @param nodes 一段的登记期节点流（顺序无关，纯累加）
 * @returns 段内帧窗池消耗（毫秒）
 */
export function poolOf(nodes: SimNode[]): Ms {
  let cursor = 0;
  for (const n of nodes) {
    if (n.kind === "step" || n.kind === "wait") cursor += n.duration;
    else if (n.kind === "loop") cursor += loopPool(n);
    else if (n.kind === "par") cursor += Math.max(0, ...n.children.map(poolOf));
  }
  return cursor;
}

/**
 * 单个循环的帧窗池消耗：`ms × times`。
 *
 * 无 `ms` 表示自管节奏（整段活跃、不占池），返回 0；无 `times` 按单轮计
 * （实际铺到段尾的长度由调用方按剩余段长夹取）。
 *
 * @param n 循环的窗口参数（只要 ms/times 两个字段）
 * @returns 该循环占用的帧窗池（毫秒）
 */
export function loopPool(n: { ms?: Ms; times?: number }): Ms {
  if (n.ms === undefined) return 0;
  return n.times === undefined ? n.ms : n.ms * n.times;
}
