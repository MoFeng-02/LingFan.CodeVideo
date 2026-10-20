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
  FrameAlpha,
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

/** 合成宿主参数 */
export interface CompositeHostOptions {
  /** 引擎画布：step 回调已经把底图画在上面 */
  readonly base: HTMLCanvasElement | OffscreenCanvas;
  /** 输出宽（像素），也是 `begin` 时申请给合成器的尺寸 */
  readonly width: number;
  /** 输出高（像素），与 `width` 一起决定输出尺寸 */
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
  /**
   * 输出透明度（省略 = `"opaque"`）；缺省取 `FrameHostInfo.alpha`。
   *
   * 引擎把 `RenderOptions.alpha` 放进 `FrameHostInfo` 交下来，正常装配不必自己填；
   * 这个字段是给「不经引擎、直接驱动宿主」的场合留的显式入口。
   */
  readonly alpha?: FrameAlpha;
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

/**
 * 把剧本的层声明与应用的渲染面按 id 配对。
 *
 * 只复制声明里实际给出的字段，缺省字段保持缺省（因此层的可见区间与叠放
 * 次序语义与剧本完全一致）。声明了但应用没给面，直接报错——不静默跳过，
 * 否则画面会少一层而难以察觉。
 *
 * @param declared 剧本声明的层（按声明顺序）
 * @param surfaces 应用提供的渲染面（id → 面）
 * @returns 合成器认识的成品层
 */
function pairLayers(
  declared: readonly LayerDeclaration[],
  surfaces: Readonly<Record<string, LayerSurface>>,
): FrameLayer[] {
  return declared.map((declaration) => {
    /** 该声明对应的渲染面；缺失即视为装配错误 */
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

/**
 * 创建合成宿主。
 *
 * 层配对在首个 `begin` 时一次性完成（剧本声明优先，其次兼容路径的成品层），
 * 之后每帧只做「挑可见层 → 让各层画 → 调合成器」。合成器在首个 `begin`
 * 时按候选顺序探测：第一个 `begin` 不抛错的就是本片使用的后端，探测失败的
 * 会被 `dispose` 掉并记进 `failedCandidates`；全部失败则抛错。
 *
 * @param options 底图、输出尺寸与层/合成器装配方式
 * @returns 实现 `FrameHost` 的宿主；用完调 `close` 释放合成器与各层资源
 */
export function createCompositeHost(
  options: CompositeHostOptions,
): CompositeHost {
  /** 应用提供的渲染面表（id → 面）；未提供时为空表 */
  const surfaces = options.surfaces ?? {};
  /** 本片实际要合成的层：剧本声明优先，其次是兼容路径的成品层 */
  let layers: readonly FrameLayer[] = options.layers ?? [];
  /** 是否已完成一次层配对（同一宿主只配对一次，重播会重建宿主） */
  let resolved = false;
  /** 实际选中的合成器；探测成功前为 `null` */
  let compositor: Compositor | null = null;
  /** 选中合成器的 id，与 `compositor` 同步更新 */
  let compositorId: string | null = null;
  /** 探测失败的合成器及其原因（`id: message` 形式，供诊断） */
  let failed: string[] = [];
  /** 本次推演的输出透明度：决定合成器清到哪种「干净」，随 `begin` 定一次 */
  let alpha: FrameAlpha = options.alpha ?? "opaque";

  /** 候选合成器工厂：显式指定时只有一个，否则用传入顺序或内置缺省 */
  const candidates: readonly (() => Compositor | null)[] = options.compositor
    ? [() => options.compositor!]
    : (options.candidates ?? DEFAULT_CANDIDATES);

  /**
   * 挑选并初始化合成器（幂等：已选中就直接返回）。
   *
   * @param size 输出尺寸（像素）
   * @returns 可用的合成器
   */
  const pick = async (size: {
    width: number;
    height: number;
  }): Promise<Compositor> => {
    if (compositor) return compositor;
    /** 探测失败的合成器记录，全部失败时拼进错误信息 */
    const errors: string[] = [];
    for (const make of candidates) {
      /** 候选实例；工厂返回 null 表示该后端不可用 */
      const candidate = make();
      if (!candidate) continue;
      try {
        // 透明度随尺寸一起交给合成器：上下文/设备的 alpha 属性在创建时定死，
        // 所以它是「建场参数」而不是「每帧参数」，换档必须重新 begin。
        await candidate.begin({ ...size, alpha });
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
      // 输出透明度是本次推演的画布语义：引擎在 RenderOptions.alpha 声明一次，
      // 随宿主参数交下来，由宿主决定「干净画布」是哪一种。显式 options.alpha 优先。
      alpha = options.alpha ?? info.alpha ?? "opaque";
      // 声明在编译期就有了：把「剧本要的层」与「应用给的面」一次配对好。
      // 只配对一次（同一宿主只服务一次推演；重播会重建宿主，这是引擎的约定）。
      if (!resolved) {
        /** 剧本声明的层（可能为空，表示走兼容路径） */
        const declared = info.layers ?? [];
        if (declared.length > 0) layers = pairLayers(declared, surfaces);
        resolved = true;
      }
      await pick({ width: info.width, height: info.height });
    },
    async frame(frame: FrameIndex, timestampMs: Ms): Promise<FrameCarrier> {
      /** 本帧可见的层，已按 z 升序排好（同 z 保持声明顺序） */
      const active = planComposite(layers, timestampMs);
      for (const layer of active) layer.surface.render(frame, timestampMs);
      /** 本帧实际使用的合成器（首帧时在这里完成探测） */
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
