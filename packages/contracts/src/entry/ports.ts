import type { Ms } from "../shared/units";
import type { Scene } from "../scene";
import type { ExportResult, Exporter } from "../export";
import type { FrameState, ValidationError } from "../feedback";
import type { AssetSource } from "../asset";
import type { AudioClock, AudioTimelineEvent } from "../audio";

/** 渲染后端 */
export type Backend = "webgpu" | "webgl" | "2d";

/**
 * RenderOptions：组合根的引擎形态。
 * - exporter 缺省 → 预览模式（实时呈现到 canvas，不产文件）
 * - exporter 注入 → 导出模式（时间线驱动，确定性；帧率/分辨率以本配置为准）
 */
export interface RenderOptions {
  fps: number;
  width: number;
  height: number;
  backend?: Backend;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  exporter?: Exporter;
  /** 资产来源（setup 阶段 assets.load 后端；缺省 = fail-fast） */
  assets?: AssetSource;
  /** 音频时钟（注入 = 音频启用：导出端离线混音 writeAudio；缺省 = 纯视频） */
  audio?: AudioClock;
  /** 时间线构建完成即刻回调：预览端据此预排音频（导出端不用，走 audio 混音） */
  onAudioScript?(events: AudioTimelineEvent[], durationMs: Ms): void;
  headless?: boolean;
  onProgress?(doneFrames: number, totalFrames: number): void;
}

export interface RenderResult {
  frames: number;
  durationMs: Ms;
  /** 注入 exporter 时返回其 finalize 结果 */
  output?: ExportResult;
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
