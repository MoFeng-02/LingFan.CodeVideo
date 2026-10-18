/**
 * 载体的判别与取用：契约只声明两种载体的形状，怎么认是基础设施的事。
 *
 * 刻意不做成契约里的判断函数——契约保持「只有类型、没有行为」。
 */
import type { FrameCarrier, FrameHandle } from "@lingfan-video/contracts";

/**
 * 是否是设备侧载体（画布 / 纹理 / 可直接包成 VideoFrame 的对象）。
 *
 * 只读 `kind` 字段，不做鸭子类型探测；CPU 位图没有 `kind` 或为 `"bitmap"`。
 *
 * @param carrier 待判断的帧载体
 * @returns `true` 时类型收窄为 `FrameHandle`
 */
export function isFrameHandle(carrier: FrameCarrier): carrier is FrameHandle {
  return (carrier as { kind?: string }).kind === "handle";
}

/**
 * 取出设备侧对象；不是句柄时明确报错，而不是静默回读像素。
 *
 * 错误发生在取值处而不是之后，调用方不会拿到「看起来像句柄」的替代物。
 *
 * @param carrier 待取用的帧载体
 * @returns 设备侧句柄（含 `native` 与尺寸）
 */
export function requireFrameHandle(carrier: FrameCarrier): FrameHandle {
  if (!isFrameHandle(carrier)) {
    throw new Error(
      "这一帧是 CPU 位图载体，没有设备侧对象：需要零拷贝的消费端请让后端交 FrameHandle",
    );
  }
  return carrier;
}
