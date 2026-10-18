/**
 * 合成宿主：把「N 个渲染后端」装配成引擎认识的一个 `FrameHost`。
 *
 * 分工是刻意的：
 * - 引擎只管按时间线逐帧要画，不关心谁在画、画在哪个设备上（契约 `FrameHost`）；
 * - 底图（引擎画布）承载 2D 内容，各层承载别的后端（shader/GPU/DOM 栅格化）；
 * - 合成器只认「一块画布 + 一个次序」，所以换合成器不影响剧本，换层不影响引擎。
 *
 * 交出的帧是 `FrameHandle`：从渲染到编码不经过 CPU 像素（零拷贝的落点）。
 */
import type {
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  Ms,
} from "@lingfan-video/contracts";
import { planComposite } from "./compose-plan";
import type { Compositor, FrameLayer } from "./types";
import { createCanvas2dCompositor } from "./canvas2d-compositor";

export interface CompositeHostOptions {
  /** 引擎画布：step 回调已经把底图画在上面 */
  readonly base: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  /** 额外的渲染层（各自一块画布，由对应后端画） */
  readonly layers?: readonly FrameLayer[];
  /** 强制指定合成器（测试/降级用）；缺省只用内置的 2D 合成器 */
  readonly compositor?: Compositor;
  /** 合成器候选顺序（越前越优先）；返回 null 表示该后端不可用 */
  readonly candidates?: readonly (() => Compositor | null)[];
}

/** 合成宿主：实现契约里的 `FrameHost`，并暴露实际选中的合成器 id */
export interface CompositeHost extends FrameHost {
  /** 首个 `begin` 之后才有值（能力探测在 begin 里做） */
  readonly compositorId: string | null;
  /** 释放合成器与后端资源（宿主自己拥有它们，调用方只管归还） */
  close(): Promise<void>;
}

/**
 * 缺省只有一块最朴素的合成器（2D 画布 `drawImage`）：不依赖任何第三方渲染包。
 * 想用 GPU，就由调用方把 GPU 合成器（例如 `frames/adapters/three` 提供的那个）
 * 排到候选列表前面——宿主不认识具体后端，这是「可替换」的落点。
 */
const DEFAULT_CANDIDATES: readonly (() => Compositor)[] = [
  createCanvas2dCompositor,
];

export function createCompositeHost(
  options: CompositeHostOptions,
): CompositeHost {
  const layers = options.layers ?? [];
  let compositor: Compositor | null = null;
  let compositorId: string | null = null;
  let failed: string[] = [];

  const candidates: readonly (() => Compositor | null)[] = options.compositor
    ? [() => options.compositor!]
    : (options.candidates ?? DEFAULT_CANDIDATES);

  const pick = async (size: {
    width: number;
    height: number;
  }): Promise<Compositor> => {
    if (compositor) return compositor;
    const errors: string[] = [];
    for (const make of candidates) {
      const candidate = make();
      if (!candidate) continue;
      try {
        await candidate.begin(size);
        compositor = candidate;
        compositorId = candidate.id;
        return candidate;
      } catch (error) {
        errors.push(`${candidate.id}: ${(error as Error).message}`);
        candidate.dispose();
      }
    }
    failed = errors;
    throw new Error(
      `没有可用的合成后端（需要一个能出帧的设备或画布）——${errors.join("；")}`,
    );
  };

  return {
    get compositorId() {
      return compositorId;
    },
    get failedCandidates() {
      return failed;
    },
    async begin(info: FrameHostInfo) {
      await pick({ width: info.width, height: info.height });
    },
    async frame(frame: FrameIndex, timestampMs: Ms): Promise<FrameCarrier> {
      const active = planComposite(layers, timestampMs);
      for (const layer of active) layer.surface.render(frame, timestampMs);
      const current = await pick({
        width: options.width,
        height: options.height,
      });
      return current.composite({
        base: options.base,
        layers: active,
        frame,
        timestampMs,
        width: options.width,
        height: options.height,
      });
    },
    async close() {
      for (const layer of layers) layer.surface.dispose?.();
      compositor?.dispose();
      compositor = null;
      compositorId = null;
    },
  } as CompositeHost & { readonly failedCandidates: readonly string[] };
}
