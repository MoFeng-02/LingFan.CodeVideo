import type { FrameIndex, Ms } from "../shared/units";

/** 帧载体（CPU 位图最小形态；数据在 CPU 侧可读写，纹理等载体由其上层自行适配） */
export interface FrameBitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 帧交出点：每帧像素从这里离开渲染端，渲染之后的一切只认此接口。
 * 变帧率下 index→timestamp 不再是均匀映射，引擎直出真时间戳（采样网格点）。
 * 测试桩与出片后端均实现本契约。
 */
export interface FrameSink {
  writeFrame(
    frame: FrameBitmap,
    index: FrameIndex,
    timestampMs: Ms,
  ): void | Promise<void>;
  finalize(): Promise<void>;
}

/**
 * 帧像素来源：把「这一刻宿主画面上是什么」取成位图交给引擎。
 * 缺省实现是从 2D 画布回读（同步）；GPU/离屏/自定义合成路径注入自己的实现。
 *
 * 可以返回 Promise：DOM/HTML/React/Vue 这类宿主没有同步抓帧能力（栅格化要等一次
 * 排版与绘制），GPU 读回与跨进程宿主同理。引擎会等待该 Promise 再交帧，
 * 因此异步宿主不会挤掉帧、也不会读到上一帧的半成品。
 */
export type FrameSource = (
  frame: FrameIndex,
  timestampMs: Ms,
) => FrameBitmap | Promise<FrameBitmap>;

/** 一次推演开始时的固定参数：宿主要用它们建舞台、定相机与时间线长度 */
export interface FrameHostInfo {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: Ms;
  readonly headless: boolean;
}

/**
 * 有生命周期的帧宿主：`begin` 建场（每次推演都会调用一次，重播即重置）、
 * `frame` 取当帧位图、`close` 收场（可不实现）。
 *
 * 什么时候需要它：宿主自己持有跨帧状态——物理积分、粒子池、第三方引擎的内部时钟、
 * 需要按 durationMs 预建轨道或缓存贴图的渲染器。纯函数来源（`FrameSource`）没有
 * 这些状态，用函数即可。约定：
 * - `begin` 之后按时间线顺序逐帧调用 `frame`，引擎逐帧等待，**不得并发重入**；
 * - 状态只能在 `begin` 初始化，不得跨 `begin` 沿用——重播与重渲染都从零开始；
 * - `frame` 返回的位图由引擎复制/编码，宿主可以复用同一块缓冲。
 */
export interface FrameHost {
  begin(info: FrameHostInfo): void | Promise<void>;
  frame(frame: FrameIndex, timestampMs: Ms): FrameBitmap | Promise<FrameBitmap>;
  close?(): void | Promise<void>;
}

/** 帧像素来源的两种形态：纯函数来源，或带生命周期的宿主 */
export type Painter = FrameSource | FrameHost;
