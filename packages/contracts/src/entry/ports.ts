import type { Ms } from "../shared/units";
import type { Scene } from "../scene";
import type { ExportResult, Exporter } from "../export";
import type { FrameState, ValidationError } from "../feedback";
import type { AssetSource } from "../asset";
import type { AudioClock, AudioOutput } from "../audio";
import type { Painter } from "../capture";
import type { InputEvent } from "../input";

/**
 * 渲染后端标识：适配器自解释的开放标识，不参与引擎行为。
 * 引擎只认 `painter` 交出的像素，不认它是谁画的——WebGPU / WebGL / three.js / 原生 SDK 画布
 * 都是适配器自己的事，新增后端不需要改契约。这里列出的三个只是常见取值的补全提示。
 */
export type Backend = "2d" | "webgpu" | "webgl" | (string & {});

/**
 * RenderOptions：组合根的引擎形态。
 *
 * exporter 是渲染端唯一注入面：预览端与导出端都实现 Exporter，不新增 FrameSink 注入口。
 * 预览传按真实时钟排帧的 Exporter（impl/format = "frames"，边跑边呈现），
 * 导出传 frames/WebCodecs/FFmpeg 实现（时间线驱动，确定性）；帧率与分辨率以本配置为准，
 * 后端不再自定。呈现方式不由引擎猜——没有后端就没有渲染产物。
 */
export interface RenderOptions {
  /** 采样密度（帧/秒）；全片基础帧率，单元可各自声明更高/更低的值 */
  fps: number;
  /** 画布宽（像素） */
  width: number;
  /** 画布高（像素） */
  height: number;
  /** 渲染后端标识（开放集合；只用于适配器选择，不参与引擎行为） */
  backend?: Backend;
  /**
   * 默认 2D 适配器的绘制目标。框架集成可以不给：只注入 `painter` 即可，
   * 引擎不会因此去找 DOM 画布（无 canvas 也能出帧）。
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /** 渲染产物出口：预览端与导出端都实现它 */
  exporter: Exporter;
  /** 资产来源（setup 阶段 assets.load 后端；缺省 = fail-fast） */
  assets?: AssetSource;
  /** 音频时钟（注入 = 导出端音频启用：程序 → 样本 → writeAudio；缺省 = 纯视频） */
  audio?: AudioClock;
  /** 音频输出（注入 = 预览端实时发声：登记期预排 + 运行期发射即时发声） */
  audioOutput?: AudioOutput;
  /**
   * 帧像素来源（缺省 = 从绘制目标 canvas 的 2D 上下文回读；
   * GPU/离屏/自定义合成路径注入自己的实现）
   *
   * 可以是纯函数来源，也可以是带生命周期的 `FrameHost`（宿主自己持有跨帧状态时用：
   * 物理积分、粒子池、第三方引擎内部时钟）。引擎每次推演都会先 `begin`，重播即重置。
   */
  painter?: Painter;
  /**
   * 无可用帧像素来源时的策略（缺省 "required"）：
   * - "required"：既无 painter、绘制目标也没有 2D 上下文 → 首帧求值 `spec_violation`（不静默交空白帧）
   * - "allow-blank"：显式接受全 0 占位位图（预览 sink 自绘、或只关心时间/音频的场合）
   */
  frames?: "required" | "allow-blank";
  /** 是否无呈现推演：不建显示面、只求值与编码 */
  headless?: boolean;
  /**
   * 输入事件表（时间线毫秒 + 归一化坐标/按键）：声明式数据，不是实时输入。
   * 引擎在采样网格上求值快照供 step/loop/wait 回调读取——
   * 同场景 + 同事件表 = 同帧序列，预览与导出因此不会分叉。
   */
  input?: readonly InputEvent[];
  /**
   * 整场随机种子（缺省 DEFAULT_PROGRAM_SEED）：只决定 `ctx.random` 的抽取序列。
   * 同一剧本 + 同一 seed + 同一调用序列 = 同一帧序列；换 seed 就是换一次抽取。
   * 随机是数据：不写进代码的隐式熵，同一份剧本才有一段可复算的推演。
   */
  seed?: number;
  /**
   * 进度回调：每写完一帧调用一次。
   * @param doneFrames 已完成的帧数
   * @param totalFrames 预计总帧数
   */
  onProgress?(doneFrames: number, totalFrames: number): void;
}

/** 推演结果：帧数、时长与导出器产物 */
export interface RenderResult {
  /** 本次实际写出的帧数 */
  frames: number;
  /** 成片时长（毫秒） */
  durationMs: Ms;
  /** exporter.finalize() 的结果；形态由该后端决定 */
  output: ExportResult;
}

/** 推演入口：推演一段剧本并返回成片结果 */
export interface RenderFn {
  /**
   * @param scene 剧本根场景
   * @param options 分辨率、帧率、导出器与各能力的注入
   * @returns 成片帧数、时长与导出器产物
   */
  (scene: Scene<unknown>, options: RenderOptions): Promise<RenderResult>;
}

/** 契约符合性检查：纯检查、无副作用，可对未渲染剧本前置运行 */
export type ValidateFn = (scene: Scene<unknown>) => ValidationError[];

/** 状态抽取：登记不重跑；[0,from) 重放模拟只弃绘制与编码 */
export interface ComputeFns {
  /**
   * 求某个时刻的状态。
   * @param scene 剧本根场景
   * @param t 时间线时刻（毫秒）
   * @returns 该时刻的逐帧状态；该时刻无活跃单元时为 undefined
   */
  computeAt<P>(scene: Scene<P>, t: Ms): Promise<FrameState | undefined>;
  /** 采样点 = 时间线采样网格（各单元自身帧率）∩ [from,to)；stepMs 保留参数位（兼容旧调用），网格密度优先 */
  computeRange<P>(
    scene: Scene<P>,
    from: Ms,
    to: Ms,
    stepMs?: Ms,
  ): Promise<FrameState[]>;
}
