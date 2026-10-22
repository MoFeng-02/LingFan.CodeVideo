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
 * 回读对**任何画布**都成立，不挑后端：2D 画布直接 `getImageData`（最快，
 * 不复制像素）；WebGL 画布与其它能当绘制源的画布先 `drawImage` 拷进一块
 * 本模块自持的 2D 画布再读。那一拷贝是像素进 CPU 的唯一通路，不是降级——
 * 合成仍然发生在原来的后端，回读只负责把结果搬下来。
 * 只要原生对象两者都不是（自定义句柄、原生窗口），就明确报错并指出替代路径，
 * 不静默交一张全黑帧。
 */

import type {
  FrameBitmap,
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  FrameSource,
  Ms,
  Painter,
} from "@lingfan-video/contracts";

/** 能回读像素的最小 2D 上下文形状（不依赖具体画布类型） */
interface Readable2D {
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { data: Uint8ClampedArray; width: number; height: number };
  drawImage(source: unknown, dx: number, dy: number): void;
}

/** 能给出 2D 上下文、或至少能被当绘制源画进 2D 画布的最小形状 */
interface ReadableCanvas {
  /** 画布宽；新建的画布要给尺寸，因此这一项可写 */
  width?: number;
  /** 画布高；同上 */
  height?: number;
  getContext?: (kind: string) => unknown;
}

/**
 * 造一块自持的 2D 画布，用来接住非 2D 后端交出来的像素。
 *
 * @returns 画布与其 2D 上下文；环境不支持 Canvas2D 时返回 `null`
 */
function makeScratch(
  width: number,
  height: number,
): { canvas: ReadableCanvas; ctx: Readable2D } | null {
  // 浏览器与 Web Worker 都有 OffscreenCanvas；没有就退回 DOM 画布
  const Offscreen = (globalThis as { OffscreenCanvas?: unknown })
    .OffscreenCanvas as
    (new (width: number, height: number) => ReadableCanvas) | undefined;
  let canvas: ReadableCanvas | null = null;
  if (typeof Offscreen === "function") {
    canvas = new Offscreen(width, height);
  } else {
    const doc = (globalThis as { document?: unknown }).document as
      { createElement?: (tag: string) => ReadableCanvas } | undefined;
    const element = doc?.createElement?.("canvas");
    if (element) {
      element.width = width;
      element.height = height;
      canvas = element;
    }
  }
  const ctx = canvas?.getContext?.("2d") as Readable2D | null | undefined;
  if (!canvas || !ctx || typeof ctx.getImageData !== "function") return null;
  return { canvas, ctx };
}

/**
 * 从设备句柄的原生对象回读整帧像素。
 *
 * 2D 画布走直读；其它画布（WebGL、离屏渲染器的输出面）走一次 `drawImage`
 * 拷进自持画布再读。两条路的产物都是同一份 RGBA 字节，谁在画由合成器决定。
 *
 * @param native 句柄的原生对象（通常是画布）
 * @param width 帧宽（像素）
 * @param height 帧高（像素）
 * @param scratch 可复用的接收画布（每帧复用同一块，避免反复分配）
 * @returns CPU 位图
 * @throws Error 原生对象既不是 2D 画布、也不能被画进画布
 */
export function readBackHandle(
  native: unknown,
  width: number,
  height: number,
  scratch?: { canvas: ReadableCanvas; ctx: Readable2D } | null,
): FrameBitmap {
  const canvas = native as ReadableCanvas | null;
  const own = canvas?.getContext?.("2d") as Readable2D | null | undefined;
  if (own && typeof own.getImageData === "function") {
    const image = own.getImageData(0, 0, width, height);
    return { data: image.data, width: image.width, height: image.height };
  }

  // 非 2D 后端：像素只在设备里，只能借绘制把结果搬进一块 CPU 可读的画布
  const target = scratch ?? makeScratch(width, height);
  if (!target || typeof target.ctx.drawImage !== "function") {
    throw new Error(
      "位图回读需要一个能画的画布：这一帧的设备句柄不是画布（自定义句柄、原生窗口之类的对象既没有 2D 上下文、也画不进 2D 画布）。要逐像素产物（如 APNG）请让帧来源交位图，或改用 FrameSequenceExporter 只取原始像素；要零拷贝出片请改用 WebCodecsExporter。",
    );
  }
  target.ctx.drawImage(canvas, 0, 0);
  const image = target.ctx.getImageData(0, 0, width, height);
  return { data: image.data, width: image.width, height: image.height };
}

/**
 * 把一帧载体转成位图：本来就是位图就原样交出（不复制）。
 *
 * @param carrier 帧载体
 * @param scratch 可复用的接收画布（非 2D 后端才用到）
 * @returns CPU 位图
 * @throws Error 句柄无法回读时
 */
export function toBitmap(
  carrier: FrameCarrier,
  scratch?: { canvas: ReadableCanvas; ctx: Readable2D } | null,
): FrameBitmap {
  if (carrier.kind !== "handle") return carrier;
  return readBackHandle(carrier.native, carrier.width, carrier.height, scratch);
}

/**
 * 造一个交位图的帧宿主：内层可以是纯函数来源，也可以是宿主。
 *
 * 接收画布在第一次需要时建好、之后每帧复用：回读是逐帧的，反复分配整幅画布
 * 会让长片在 GC 上抖起来。
 *
 * @param inner 内层帧来源
 * @returns 逐帧交 CPU 位图的宿主
 */
export function createReadbackHost(inner: Painter): FrameHost {
  const source: FrameSource | null = typeof inner === "function" ? inner : null;
  const host: FrameHost | null = source ? null : (inner as FrameHost);
  /** 非 2D 后端的接收画布；2D 直读路径永远是 `null` */
  let scratch: { canvas: ReadableCanvas; ctx: Readable2D } | null = null;
  return {
    async begin(info: FrameHostInfo): Promise<void> {
      // 内层是宿主时生命周期必须透传：它按 begin 重置跨帧状态，重播才不会串
      if (host) await host.begin(info);
    },
    async frame(frame: FrameIndex, timestampMs: Ms): Promise<FrameBitmap> {
      const carrier = source
        ? await source(frame, timestampMs)
        : await (host as FrameHost).frame(frame, timestampMs);
      if (carrier.kind !== "handle") return carrier;
      if (!scratch) scratch = makeScratch(carrier.width, carrier.height);
      return toBitmap(carrier, scratch);
    },
    async close(): Promise<void> {
      if (host) await host.close?.();
    },
  };
}
