/**
 * 引擎运行期状态与装配选项的类型面：时间线结构（段、spawn 链、层、总线、声音）
 * 加上一次推演内的可变记录。
 *
 * 这里的类型只描述引擎内部的数据形状，不构成契约：契约类型在
 * `@lingfan-video/contracts`，本文件只把契约类型组合成运行期需要的样子。
 * 可变状态集中在一处、由自由函数显式传参共享，不散落到模块级全局。
 */
import type {
  AssetSource,
  AudioGraph,
  AudioOutput,
  AudioVoice,
  BusPoint,
  BusSpec,
  DuckRule,
  FrameCarrier,
  FrameIndex,
  FrameState,
  InputEvent,
  InputSnapshot,
  InputTrack,
  LayerDeclaration,
  Ms,
  RandomStream,
  SendSpec,
} from "@lingfan-video/contracts";
import type {
  CompiledSegment,
  SceneInternal,
} from "../../domain/simulation/types";
import type { MutableVoice } from "./audio-runtime";
import type { DeclaredAutomation } from "./bus-automation";

/** 全局化后的层声明：绝对故事时间，缺省区间已填满 */
export interface GlobalLayer extends LayerDeclaration {
  /** 生效起点（绝对故事时间毫秒，含） */
  readonly from: Ms;
  /** 生效终点（绝对故事时间毫秒，不含）；缺省取该次出现的段窗末尾 */
  readonly to: Ms;
}

/** 链上一段时间线占位（transition 提前收窗：end 取 activeEnd） */
export interface ChainSpan {
  /** 本段对应的场景（提供 id 与段级信息） */
  scene: SceneInternal<unknown>;
  /** 本段的编译产物（单元、段内音频/层/总线声明） */
  seg: CompiledSegment;
  /** 本段在时间线上的起点（全局毫秒，含） */
  start: Ms;
  /** 本段在时间线上的终点（全局毫秒，不含）；已扣掉 transition 提前收窗 */
  end: Ms;
}

/** 一条 spawn 链（同 key 去重的调度单位） */
export interface SpawnChain {
  /** 去重键：同 key 且时间窗重叠时视为同一链（续接，返回既有句柄） */
  key: string;
  /** 链上的段窗口，按时间顺序；异步 setup 的链物化后可能被整体平移 */
  spans: ChainSpan[];
  /** 链起点（全局毫秒，含） */
  start: Ms;
  /** 链终点（全局毫秒，不含）；forever 先记 Infinity，终界确定后夹取 */
  end: Ms;
  /** 是否已硬杀：被杀链不再求值、也不贡献采样点 */
  killed: boolean;
  /** 链内容是否已编译完成（异步 setup 的运行期 spawn 会在帧边界补完，见 PendingSpawn） */
  materialized: boolean;
  /** end 是否由 spawn 参数定死（forever / 显式 duration）；缺省链长按内容实况回填 */
  fixedEnd: boolean;
  /** 消亡窗口起点（kill/dispose 带 fadeOut 时写入；窗口内继续求值） */
  dyingFrom?: Ms;
  /** 消亡窗口终点（含）；t >= 此值 → 真正出池 */
  dyingUntil?: Ms;
}

/**
 * 引擎构造选项：一次推演的静态配置（帧尺寸、采样密度、注入面）。
 *
 * 与契约的 `RenderOptions` 一一对应但不含渲染后端：导出器由组合根适配成
 * `FrameSink`，帧来源由 `setPainter` / `setFrameSource` 注入。
 */
export interface EngineOptions {
  /** 基础采样密度（帧/秒，> 0）：单元未声明 fps 时的缺省值；网格取各单元采样点并集 */
  fps: number;
  /** 帧宽（像素，> 0） */
  width: number;
  /** 帧高（像素，> 0） */
  height: number;
  /** 登记期交给回调的绘制目标（`ctx.canvas`）；headless 下可为占位对象，回调不得调 canvas API */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** 无真实画布 / DOM 时为 true（只做模拟求值，或帧像素由宿主自绘提供） */
  headless: boolean;
  /** 资产来源（setup 阶段 assets.load 的后端；缺省 = fail-fast 实现） */
  assets?: AssetSource;
  /** 预览端实时音频输出（注入 = 运行期发射即时发声；缺省 = 只记录声音） */
  audioOut?: AudioOutput;
  /** 输入事件表（缺省 = 空轨道：指针在原点未按下、无按键） */
  input?: readonly InputEvent[];
  /** 整场随机种子（缺省 = DEFAULT_PROGRAM_SEED；非法值开工即炸） */
  seed?: number;
}

/**
 * 一次推演的结果画像：帧已逐帧交给 sink，这里只交出计数、时长与整条时间线的声音。
 *
 * 声音记录是导出端离线混音的唯一输入（登记期声明 + 运行期发射）。
 */
export interface RunSummary {
  /** 本次写出并通过 sink 交出的帧数（等于采样网格点数；空窗时间线为 0） */
  frames: number;
  /** 时间线终界（毫秒）：主链池尾与有界 spawn 链内容末点的较大者 */
  durationMs: Ms;
  /** 最后一个求值点的完整状态表（不做帧终裁剪，便于调用方取整场终态） */
  lastState: FrameState;
  /** 全时间线声音记录（登记期声明 + 运行期发射；导出端据此离线渲染） */
  audioVoices: readonly AudioVoice[];
  /** 全时间线音频图（总线拓扑 + 参数轨迹；导出端离线混音用） */
  audioGraph: AudioGraph;
}

/** 运行期总线参数（句柄改动的当前值；未登记 = master 直连） */
export interface BusParams {
  /** 线性幅度（0 起，1 = 原样）；缺省 1 */
  gain: number;
  /** 声像：-1 全左 ~ 1 全右；缺省 0（居中） */
  pan: number;
  /** 是否静音；缺省 false */
  mute: boolean;
  /** 是否独奏；缺省 false */
  solo: boolean;
}

/**
 * 单参数过渡：回调内 gain/pan 带 rampMs 时登记，逐帧采样时求值。
 * 起点值取登记时刻的**有效**参数值——过渡未结束时再次登记，从当前插值处重新起坡。
 */
export interface ParamRamp {
  /** 起点时刻（时间线毫秒） */
  fromMs: Ms;
  /** 过渡时长（毫秒，> 0） */
  ms: Ms;
  /** 起点值（登记时刻的有效值） */
  from: number;
  /** 目标值 */
  to: number;
}

/** 总线运行期过渡：每个参数至多一条在途过渡 */
export interface BusRampState {
  /** gain 的在途过渡（无 = 已到位） */
  gain?: ParamRamp;
  /** pan 的在途过渡（无 = 已到位） */
  pan?: ParamRamp;
}

/**
 * 待物化的运行期 spawn：帧内只登记链壳，异步 setup 的 Promise 在帧边界补完
 * （帧内不得等待 I/O，所以链的实际起点 = 帧尾之后第一个采样点）。
 */
export interface PendingSpawn {
  /** 已登记但尚未物化完成的链壳 */
  chain: SpawnChain;
  /** 待继续编译的场景：它的 setup 返回了 Promise */
  head: SceneInternal<unknown>;
  /** setup 的 Promise；帧边界处已完成后才继续编译 */
  promise: PromiseLike<unknown>;
  /** 链级继承帧率（spawn 选项里的 fps；缺省 = 引擎基础帧率） */
  chainFps?: number;
  /** 已编译前缀的内容末点（全局毫秒）：恢复时从链起点平移后的位置接着走 */
  cursor: Ms;
  /** 链上 body 的 prev 传参（恢复时接着用） */
  prev: unknown;
  /** 已见过的场景 id（成环检测跨恢复保留） */
  seen: Set<string>;
  /** 上一段声明的重叠窗（恢复时接着用） */
  pendingOverlap: Ms;
}

/**
 * 一次推演的全部可变状态：时间线结构（段、链、层、总线）加运行期记录（声音、去重键、消亡窗口）。
 *
 * 构建期（buildTimeline）写入时间线结构，求值期（evaluateFrame）写入运行期记录；
 * 每次构建前由 resetTimeline 复位，因此重复构建不会串上一轮的结构。
 * 随机流与单元子流缓存不在复位范围内，引擎实例按一次推演使用。
 */
export interface TimelineState {
  /** 本次推演的静态配置 */
  opts: EngineOptions;
  /** 硬死键集合：`${sceneId}/${unitKey}`（loop 为宿主锚点），立即不求值 */
  deadUnits: Set<string>;
  /** 单元级消亡窗口：key → {from,until}；窗口内继续求值并暴露 disposing */
  dyingUnits: Map<string, { from: Ms; until: Ms }>;
  /** 全部 spawn 链（含已硬杀与尚未物化的链壳） */
  spawnChains: SpawnChain[];
  /** 声音记录（登记期已全局化；运行期发射追加） */
  audioVoices: MutableVoice[];
  /** 声音 id 序号（确定性分配） */
  voiceSeq: number;
  /** 事件去重登记（确定性键：作用域 + 单元实例 + 迭代/实例 id） */
  onceKeys: Set<string>;
  /** 音频图拓扑（登记期声明；同 id / 同 from→to 覆盖） */
  busSpecs: Map<string, BusSpec>;
  /** 发送声明：键 = `from->to`，同键后声明覆盖 */
  sends: Map<string, SendSpec>;
  /** 侧链压制规则：键 = `from->to`，同键后声明覆盖 */
  ducks: Map<string, DuckRule>;
  /** 运行期总线参数当前值 */
  busParams: Map<string, BusParams>;
  /** 运行期参数过渡（gain/pan 带 rampMs 时登记；逐帧采样时按时刻求值） */
  busRamps: Map<string, BusRampState>;
  /** 上一次逐帧参数下发时刻（预览端过渡时长 = 相邻帧间隔） */
  busFlushAt?: Ms;
  /** 参数轨迹（逐帧采样；program 构建时按时间排序） */
  busPoints: Map<string, BusPoint[]>;
  /** 总线消亡窗口 */
  busKill: Map<string, { from: Ms; until: Ms }>;
  /** 声明式自动化队列（全局时刻；每帧推进游标，按声明时刻起坡） */
  busAutomation: Map<string, DeclaredAutomation>;
  /** 未给 ms 的 loop：迭代号与迭代起点（按单元键登记） */
  selfPaced: Map<string, { iteration: number; iterStart: Ms }>;
  /** 主链段窗口（按链上顺序；重叠窗内可能有多段同时活跃，后者后绘制） */
  spans: ChainSpan[];
  /** 运行期 spawn 待物化的链（异步 setup 未完成的）：帧边界补完，帧内不等待 I/O */
  pendingSpawns: PendingSpawn[];
  /** 时间线结构版本号：链/段变化即自增，引擎据此重采样网格 */
  timelineEpoch: number;
  /** 时间线终界（毫秒）：构建期算出，主链池尾与有界链内容末点的较大者 */
  timelineEnd: Ms;
  /** 画面层声明（剧本登记；绝对故事时间，缺省区间已填满） */
  layers: Map<string, GlobalLayer>;
  /** 输入轨道（声明式事件表；逐帧求值出快照） */
  input: InputTrack;
  /** 当前帧的输入快照（逐帧求值一次，同帧所有单元共享同一份） */
  nowInput: InputSnapshot;
  /** 程序随机源（开工时按种子建一次） */
  random: RandomStream;
  /** 程序随机源种子（开工时归一化；重复推演复位根流时复用） */
  randomSeed: number;
  /** 单元随机子流缓存：标签 → 流（同一单元跨帧连续抽取） */
  randomStreams: Map<string, RandomStream>;
  /** 已完成 setup 的场景（每次推演复位；同一场景只跑一次 setup，资产只解码一次） */
  setupDone: WeakSet<object>;
  /** 当前求值时间（句柄操作／alive 判定的时间轴依据） */
  nowMs: Ms;
  /** 是否处于回调执行中（句柄操作的合法窗口） */
  inCallback: boolean;
}

/** 引擎运行期句柄集合（frame-eval / spawn-handle 间共享的最小面） */
export interface EvalDeps {
  /** 共享的可变状态（求值期读写） */
  state: TimelineState;
  /** 帧级状态聚合：按 `${sceneId}/${unitKey}` 发布，帧终取快照交给帧来源 */
  aggregator: import("../../domain/simulation").StateAggregator;
  /** 取一帧载体：帧号（从 0 起）、时刻（毫秒）、本帧状态表 → 位图/设备句柄（可返回 Promise） */
  painterPaint: (
    f: FrameIndex,
    t: Ms,
    state: FrameState,
  ) => FrameCarrier | Promise<FrameCarrier>;
}
