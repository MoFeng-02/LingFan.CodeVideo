/**
 * 合成宿主：把「N 个渲染后端」装配成引擎认识的一个 `FrameHost`。
 *
 * 分工是刻意的，也是「层声明」这件事的落点：
 * - **剧本**说有几层、叠在谁上面、什么时候在（`env.layer(...)` → `FrameHostInfo.layers`）；
 * - **宿主**（应用）提供每一层的渲染面：id → 一块画布 + 谁来画它；
 * - **合成器**只认「一块画布 + 一个次序」，所以换合成器不影响剧本，换后端不影响引擎。
 *
 * 一句话：声明来自剧本，面来自应用，合成是单点。剧本不认识渲染器，渲染器不认识剧本。
 *
 * 交出的帧是 `FrameHandle`：从渲染到编码不经过 CPU 像素（零拷贝的落点）。
 */
import type {
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  LayerDeclaration,
  Ms,
} from "@lingfan-video/contracts";
import { planComposite } from "./compose-plan";
import type { Compositor, FrameLayer, LayerSurface } from "./types";
import { createCanvas2dCompositor } from "./canvas2d-compositor";

export interface CompositeHostOptions {
  /** 引擎画布：step 回调已经把底图画在上面 */
  readonly base: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  /**
   * 层的渲染面：`id` → 谁来画这一层。id 必须与剧本 `env.layer({ id })` 对上。
   * 宿主不认识具体渲染器——3D、shader、DOM 栅格化都只是「一块能出画的画布」。
   */
  readonly surfaces?: Readonly<Record<string, LayerSurface>>;
  /**
   * 兼容路径：剧本没有声明层时，直接给「声明 + 面」的成品层。
   * 两条路径不要混用——剧本一旦声明了层，以剧本为准。
   */
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
  /** 探测失败过的合成器（诊断用） */
  readonly failedCandidates: readonly string[];
  /** 释放合成器与后端资源（宿主自己拥有它们，调用方只管归还） */
  close(): Promise<void>;
}

/**
 * 缺省只有一块最朴素的合成器（2D 画布 `drawImage`）：不依赖任何第三方渲染包。
 * 想用 GPU，就由调用方把 GPU 合成器（例如 `frames/adapters/three-compositor`
 * 提供的那个）排到候选列表前面——宿主不认识具体后端，这是「可替换」的落点。
 */
const DEFAULT_CANDIDATES: readonly (() => Compositor)[] = [
  createCanvas2dCompositor,
];

/** 把剧本的层声明与应用的渲染面按 id 配对 */
function pairLayers(
  declared: readonly LayerDeclaration[],
  surfaces: Readonly<Record<string, LayerSurface>>,
): FrameLayer[] {
  return declared.map((declaration) => {
    const surface = surfaces[declaration.id];
    if (!surface)
      throw new Error(
        `剧本声明了层 "${declaration.id}"，但宿主没有提供它的渲染面：请在 surfaces 里给出这个 id 的 LayerSurface（剧本与宿主的唯一配对键就是 id）`,
      );
    return {
      spec: {
        id: declaration.id,
        ...(declaration.z === undefined ? {} : { z: declaration.z }),
        ...(declaration.blend === undefined
          ? {}
          : { blend: declaration.blend }),
        ...(declaration.from === undefined ? {} : { from: declaration.from }),
        ...(declaration.to === undefined ? {} : { to: declaration.to }),
      },
      surface,
    };
  });
}

export function createCompositeHost(
  options: CompositeHostOptions,
): CompositeHost {
  const surfaces = options.surfaces ?? {};
  /** 本片实际要合成的层：剧本声明优先，其次是兼容路径的成品层 */
  let layers: readonly FrameLayer[] = options.layers ?? [];
  let resolved = false;
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
      // 声明在编译期就有了：把「剧本要的层」与「应用给的面」一次配对好。
      // 只配对一次（同一宿主只服务一次推演；重播会重建宿主，这是引擎的约定）。
      if (!resolved) {
        const declared = info.layers ?? [];
        if (declared.length > 0) layers = pairLayers(declared, surfaces);
        resolved = true;
      }
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
      resolved = false;
    },
  };
}
