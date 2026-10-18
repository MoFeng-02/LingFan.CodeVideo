/**
 * 载体的判别与取用：契约只声明两种载体的形状，怎么认是基础设施的事。
 *
 * 刻意不做成契约里的判断函数——契约保持「只有类型、没有行为」。
 */
import type { FrameCarrier, FrameHandle } from "@lingfan-video/contracts";

/** 是否是设备侧载体（画布 / 纹理 / 可直接包成 VideoFrame 的对象） */
export function isFrameHandle(carrier: FrameCarrier): carrier is FrameHandle {
  return (carrier as { kind?: string }).kind === "handle";
}

/** 取出设备侧对象；不是句柄时明确报错，而不是静默回读像素 */
export function requireFrameHandle(carrier: FrameCarrier): FrameHandle {
  if (!isFrameHandle(carrier)) {
    throw new Error(
      "这一帧是 CPU 位图载体，没有设备侧对象：需要零拷贝的消费端请让后端交 FrameHandle",
    );
  }
  return carrier;
}
