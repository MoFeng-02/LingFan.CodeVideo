/**
 * Canvas2D 合成器（兜底）：把底图与各层 `drawImage` 叠到一张 2D 画布上。
 *
 * 它也在「零拷贝」序列里：2D 画布同样能被 `VideoFrame` 直接包住，
 * 所以即便机器没有 WebGL2/WebGPU，帧到编码器这一段仍然不回读像素。
 * 差别只在合成是 CPU 光栅（GPU 光栅）而不是 GPU 着色管线。
 */
import type { FrameHandle } from "@lingfan-video/contracts";
import type { CompositeInput, Compositor } from "./types";

export function createCanvas2dCompositor(): Compositor {
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  let ctx: CanvasRenderingContext2D | null = null;

  return {
    id: "canvas2d",
    begin(size) {
      canvas =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(size.width, size.height)
          : document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      ctx = (canvas as HTMLCanvasElement).getContext("2d", {
        alpha: false,
      }) as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error("Canvas2D 合成器初始化失败：拿不到 2d 上下文");
    },
    async composite(input: CompositeInput): Promise<FrameHandle> {
      if (!canvas || !ctx)
        throw new Error("Canvas2D 合成器未初始化：先调 begin()");
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
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
    dispose() {
      canvas = null;
      ctx = null;
    },
  };
}
