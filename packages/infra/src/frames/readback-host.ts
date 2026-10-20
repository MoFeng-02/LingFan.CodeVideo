/**
 * 位图回读宿主：把一个交设备句柄的帧来源，转成交 CPU 位图的帧来源。
 *
 * 透明产物需要逐像素编码（APNG 就是这条路），而合成器交出的
 * `FrameHandle` 只承诺「同一设备内的消费端能用」，不承诺 CPU 可读。
 * 回读因此不放在导出器里——导出器回读像素等于把编码降级成事后补救，
 * 也违反「不许静默回读」的约定；它属于帧来源这一侧的选择：
 * 要位图就在装配时声明要位图。
 *
 * 它同时是**装饰器**：内层仍可以是任意 `Painter`（纯函数来源或带生命周期的
 * 宿主），生命周期的 `begin`/`close` 原样透传，所以内层是合成宿主时照常工作。
 *
 * 回读只在 2D 画布上可行：`OffscreenCanvas`/`HTMLCanvasElement` 的 2D 上下文
 * 能 `getImageData`。WebGL 设备与自定义原生对象拿不到 2D 上下文，
 * 这时明确报错并指出替代路径，不静默交一张全黑帧。
 */

import type {
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  FrameSource,
  Ms,
  Painter,
} from "@lingfan-video/contracts";
import type { FrameBitmap } from "@lingfan-video/contracts";

/** 能回读像素的最小 2D 上下文形状（不依赖具体画布类型） */
interface Readable2D {
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { data: Uint8ClampedArray; width: number; height: number };
}

/** 能给出 2D 上下文的最小画布形状 */
interface ReadableCanvas {
  getContext?: (kind: string) => unknown;
}

/**
 * 从设备句柄的原生对象回读整帧像素。
 *
 * @param native 句柄的原生对象（通常是画布）
 * @param width 帧宽（像素）
 * @param height 帧高（像素）
 * @returns CPU 位图
 * @throws Error 原生对象不是 2D 画布，无法回读
 */
export function readBackHandle(
  native: unknown,
  width: number,
  height: number,
): FrameBitmap {
  const canvas = native as ReadableCanvas | null;
  const ctx = canvas?.getContext?.("2d") as Readable2D | null | undefined;
  if (!ctx || typeof ctx.getImageData !== "function") {
    throw new Error(
      "位图回读需要 2D 画布：这一帧的设备句柄不是 2D 画布（GPU 纹理、原生窗口之类的对象没有 getImageData）。要逐像素产物（如 APNG）请用 Canvas2D 合成器，或让宿主直接交 FrameBitmap；要零拷贝出片请改用 WebCodecsExporter。",
    );
  }
  const image = ctx.getImageData(0, 0, width, height);
  return { data: image.data, width: image.width, height: image.height };
}

/**
 * 把一帧载体转成位图：本来就是位图就原样交出（不复制）。
 *
 * @param carrier 帧载体
 * @returns CPU 位图
 * @throws Error 句柄无法回读时
 */
export function toBitmap(carrier: FrameCarrier): FrameBitmap {
  if (carrier.kind !== "handle") return carrier;
  return readBackHandle(carrier.native, carrier.width, carrier.height);
}

/**
 * 造一个交位图的帧宿主：内层可以是纯函数来源，也可以是宿主。
 *
 * @param inner 内层帧来源
 * @returns 逐帧交 CPU 位图的宿主
 */
export function createReadbackHost(inner: Painter): FrameHost {
  const source: FrameSource | null = typeof inner === "function" ? inner : null;
  const host: FrameHost | null = source ? null : (inner as FrameHost);
  return {
    async begin(info: FrameHostInfo): Promise<void> {
      // 内层是宿主时生命周期必须透传：它按 begin 重置跨帧状态，重播才不会串
      if (host) await host.begin(info);
    },
    async frame(frame: FrameIndex, timestampMs: Ms): Promise<FrameBitmap> {
      const carrier = source
        ? await source(frame, timestampMs)
        : await (host as FrameHost).frame(frame, timestampMs);
      return toBitmap(carrier);
    },
    async close(): Promise<void> {
      if (host) await host.close?.();
    },
  };
}
