import type { Ms } from "../shared/units";
import type { Scene } from "../scene";
import type { ExportResult, Exporter } from "../export";
import type { FrameState, ValidationError } from "../feedback";
import type { AssetSource } from "../asset";
import type { AudioClock, AudioOutput } from "../audio";
import type { FrameSource } from "../capture";
import type { InputEvent } from "../input";

/** 渲染后端 */
export type Backend = "webgpu" | "webgl" | "2d";

/**
 * RenderOptions：组合根的引擎形态。
 *
 * exporter 是渲染端唯一注入面：预览端与导出端都实现 Exporter，不新增 FrameSink 注入口。
 * 预览传按真实时钟排帧的 Exporter（impl/format = "frames"，边跑边呈现），
 * 导出传 frames/WebCodecs/FFmpeg 实现（时间线驱动，确定性）；帧率与分辨率以本配置为准，
 * 后端不再自定。呈现方式不由引擎猜——没有后端就没有渲染产物。
 */
export interface RenderOptions {
  fps: number;
  width: number;
  height: number;
  backend?: Backend;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
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
   */
  painter?: FrameSource;
  /**
   * 无可用帧像素来源时的策略（缺省 "required"）：
   * - "required"：既无 painter、绘制目标也没有 2D 上下文 → 首帧求值 `spec_violation`（不静默交空白帧）
   * - "allow-blank"：显式接受全 0 占位位图（预览 sink 自绘、或只关心时间/音频的场合）
   */
  frames?: "required" | "allow-blank";
  headless?: boolean;
  /**
   * 输入事件表（时间线毫秒 + 归一化坐标/按键）：声明式数据，不是实时输入。
   * 引擎在采样网格上求值快照供 step/loop/wait 回调读取——
   * 同场景 + 同事件表 = 同帧序列，预览与导出因此不会分叉。
   */
  input?: readonly InputEvent[];
  onProgress?(doneFrames: number, totalFrames: number): void;
}

export interface RenderResult {
  frames: number;
  durationMs: Ms;
  /** exporter.finalize() 的结果；形态由该后端决定 */
  output: ExportResult;
}

export interface RenderFn {
  (scene: Scene<unknown>, options: RenderOptions): Promise<RenderResult>;
}

/** 契约符合性检查：纯检查、无副作用，可对未渲染剧本前置运行 */
export type ValidateFn = (scene: Scene<unknown>) => ValidationError[];

/** 状态抽取：登记不重跑；[0,from) 重放模拟只弃绘制与编码 */
export interface ComputeFns {
  computeAt<P>(scene: Scene<P>, t: Ms): Promise<FrameState | undefined>;
  /** 采样点 = 时间线采样网格（各单元自身帧率）∩ [from,to)；stepMs 保留参数位（兼容旧调用），网格密度优先 */
  computeRange<P>(
    scene: Scene<P>,
    from: Ms,
    to: Ms,
    stepMs?: Ms,
  ): Promise<FrameState[]>;
}
