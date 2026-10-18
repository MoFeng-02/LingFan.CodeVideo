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
