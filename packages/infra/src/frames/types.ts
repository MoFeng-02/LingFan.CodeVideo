import type { FrameIndex, Ms } from "@lingfan-video/contracts";

/**
 * 一层画面在时间线上的可见区间（左闭右开，故事时间毫秒）。
 * 不给 `from`/`to` 表示整段可见——区间是剧本语义，不是后端参数。
 */
export interface LayerSpan {
  readonly from?: Ms;
  readonly to?: Ms;
}

/** 一层的声明：次序与可见区间。层的内容由 `LayerSurface` 负责画。 */
export interface LayerSpec extends LayerSpan {
  readonly id: string;
  /** 叠放次序，升序在下面；缺省按声明顺序 */
  readonly z?: number;
  /** 合成方式：`glow` 为叠加（光效层），缺省为普通 alpha 叠放 */
  readonly blend?: "normal" | "glow";
}

/**
 * 一个渲染后端的承载面：自己一块画布，负责把「这一帧」画进去。
 *
 * 这是「N 后端可组合」的接缝：后端可以是 2D 画布、WebGL2、WebGPU 或任何
 * 能把结果放进一块画布的渲染器；合成器不需要认识它们，只认识这块画布。
 */
export interface LayerSurface {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** 层自己的画布：合成器只认这块画布，不认识它背后是什么渲染器 */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** 把本帧内容画进自己的画布（同步提交即可，不必等 GPU 完成） */
  render(frame: FrameIndex, timestampMs: Ms): void;
  dispose?(): void;
}

export interface FrameLayer {
  readonly spec: LayerSpec;
  readonly surface: LayerSurface;
}

/** 合成一次的输入：底图（引擎画布，CPU 2D 内容已画好）+ 本帧要叠的层 */
export interface CompositeInput {
  readonly base: HTMLCanvasElement | OffscreenCanvas;
  readonly layers: readonly FrameLayer[];
  readonly frame: FrameIndex;
  readonly timestampMs: Ms;
  readonly width: number;
  readonly height: number;
}

/**
 * 合成器：把底图与若干层合成成一帧，交出**设备侧**帧载体。
 * 交出的载体是 `FrameHandle`——不经过 CPU 像素，这是零拷贝的落点。
 */
export interface Compositor {
  readonly id: string;
  begin(size: { width: number; height: number }): void | Promise<void>;
  composite(
    input: CompositeInput,
  ): Promise<import("@lingfan-video/contracts").FrameHandle>;
  dispose(): void;
}
