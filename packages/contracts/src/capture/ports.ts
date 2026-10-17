import type { FrameIndex, Ms } from "../shared/units";

/** 帧载体（CPU 位图最小形态；GPU 纹理路径由后续版本泛型化——载体中立化） */
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
