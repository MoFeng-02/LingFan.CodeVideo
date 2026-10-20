/**
 * Canvas2D 合成器（兜底）：把底图与各层 `drawImage` 叠到一张 2D 画布上。
 *
 * 它也在「零拷贝」序列里：2D 画布同样能被 `VideoFrame` 直接包住，
 * 所以即便机器没有 WebGL2/WebGPU，帧到编码器这一段仍然不回读像素。
 * 差别只在合成是 CPU 光栅（GPU 光栅）而不是 GPU 着色管线。
 *
 * 输出透明度由 `begin` 的 `alpha` 决定，两档只差上下文创建与「干净」的定义：
 * 不透明档清到不透明黑，透明档清到全透明。每帧都从干净画布开始这一条不变。
 */
import type { FrameAlpha, FrameHandle } from "@lingfan-video/contracts";
import type { CompositeInput, Compositor } from "./types";

/**
 * 创建 Canvas2D 合成器。
 *
 * 优先用 `OffscreenCanvas`（可在 worker 里跑），环境没有时退回 DOM canvas；
 * 两次创建都拿不到 2D 上下文就在 `begin` 里报错，不会静默降级成空帧。
 * 兜底路径因此是「有 2D 画布就能出片」，不要求 WebGL2/WebGPU。
 *
 * @returns 合成器实例；`begin` 前不可调用 `composite`
 */
export function createCanvas2dCompositor(): Compositor {
  /** 复用的输出画布：`begin` 时创建，之后每帧原地重画 */
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  /** 输出画布的 2D 上下文，与 `canvas` 同生命周期 */
  let ctx: CanvasRenderingContext2D | null = null;
  /** 本次 `begin` 定的输出透明度：决定「干净画布」是哪一种 */
  let alpha: FrameAlpha = "opaque";

  return {
    id: "canvas2d",
    begin(size) {
      alpha = size.alpha ?? "opaque";
      canvas =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(size.width, size.height)
          : document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      // alpha 属性在创建上下文时定死：透明档必须显式 alpha:true，
      // 否则 clearRect 清出来的是不透明黑，alpha 通道在这一步就丢了。
      ctx = (canvas as HTMLCanvasElement).getContext("2d", {
        alpha: alpha === "alpha",
      }) as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error("Canvas2D 合成器初始化失败：拿不到 2d 上下文");
    },
    /**
     * 合成一帧：清屏 → 画底图 → 按顺序叠层 → 交回画布句柄。
     *
     * 每帧都从清空开始（不做增量合成），因此必须能接受大面积透明底图；
     * `glow` 层用 `lighter` 叠加，其余用 `source-over`。句柄借用同一块画布，
     * `close()` 是空操作，下一帧会把它覆盖。
     */
    async composite(input: CompositeInput): Promise<FrameHandle> {
      if (!canvas || !ctx)
        throw new Error("Canvas2D 合成器未初始化：先调 begin()");
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      // 每帧都是独立合成：底图允许大面积透明（`frames: "allow-blank"`），
      // 上一帧的像素不能留下来。GPU 合成器用同一份 alpha 声明清到同一种
      // 「干净」，两档合成器的输出才对得上。
      ctx.clearRect(0, 0, input.width, input.height);
      ctx.drawImage(
        input.base as CanvasImageSource,
        0,
        0,
        input.width,
        input.height,
      );
      for (const layer of input.layers) {
        ctx.globalCompositeOperation =
          layer.spec.blend === "glow" ? "lighter" : "source-over";
        ctx.drawImage(
          layer.surface.canvas as CanvasImageSource,
          0,
          0,
          input.width,
          input.height,
        );
      }
      ctx.globalCompositeOperation = "source-over";
      return {
        kind: "handle",
        native: canvas,
        width: input.width,
        height: input.height,
        close() {
          /* 画布由合成器复用，句柄只是借用 */
        },
      };
    },
    /** 释放引用：画布与上下文交给 GC，之后需重新 `begin` 才能合成 */
    dispose() {
      canvas = null;
      ctx = null;
    },
  };
}
