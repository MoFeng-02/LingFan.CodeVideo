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
 * 测试桩与录制器均实现本契约。
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
 * 帧像素来源：把「这一刻画布上画了什么」取成位图交给引擎。
 * 单一事实来源是绘制目标本身（ctx.canvas）——缺省实现即从画布 2D 上下文回读；
 * GPU/离屏/自定义合成路径注入自己的实现（自绘纹理、后处理）。
 */
export type FrameSource = (frame: FrameIndex, timestampMs: Ms) => FrameBitmap;
