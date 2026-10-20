/**
 * three.js **GPU 合成器**：把底图与各层当作全屏四边形，一次 `render` 交出一块 WebGL 画布。
 *
 * 与 `canvas2d-compositor` 的差别只在「谁来叠」：这里 GPU 叠，CPU 不碰像素；
 * 交出的仍然是 `FrameHandle`（`native` 是这块 WebGL 画布），所以导出端可以直接
 * `new VideoFrame(glCanvas)` 编码——这条路上一次 CPU 位图都不产生。
 *
 * **只给非实时的消费端用（导出 / 离线取帧），不要接进实时预览。**
 * 这个合成器每帧要把底图与每层各当纹理重传一次；其中三维层的源本身就是一块 WebGL 画布，
 * 上传它要等 GPU 管线同步。一帧三块 1280×720 的同步上传，在按音频时钟逐帧放行的预览里
 * 会把主线程长时间占满：一次 JS 调用可能迟迟不返回，页面随即失去响应。
 * 实时消费端的正确选择是 `canvas2d-compositor`：浏览器的 `drawImage` 本身就走 GPU 合成，
 * 叠几块画布几乎不要钱。两者的叠放结果（层序、z、`blend`）完全一致，只是谁来做这件事。
 *
 * 放在子路径导出（`@lingfan-video/infra/frames/adapters/three-compositor`）：
 * 不用 GPU 的调用方不会被拖进 three 依赖。
 */
import {
  AdditiveBlending,
  CanvasTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import type { FrameAlpha, FrameHandle } from "@lingfan-video/contracts";
import type { CompositeInput, Compositor, FrameLayer } from "../types";

/** GPU 合成器参数 */
export interface ThreeCompositorOptions {
  /** 画布 id，缺省 `three` */
  readonly id?: string;
  /** 保留绘制缓冲：抓帧（VideoFrame）与贴回舞台都需要渲染结果可读 */
  readonly preserveDrawingBuffer?: boolean;
}

/** 一块画布的 GPU 承载：四边形网格 + 贴图 + 上一帧的来源画布 */
interface Slot {
  /** 全屏四边形；缩放为输出尺寸，位置在原点 */
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  /** 把来源画布当纹理上传的对象，画布变化时重绑 `image` */
  readonly texture: CanvasTexture;
  /** 上一帧画布身份：换了画布要换贴图源 */
  canvas: HTMLCanvasElement | OffscreenCanvas | null;
}

/**
 * 创建 three.js GPU 合成器。
 *
 * 初始化是惰性的：第一次 `begin` / `composite` 时按尺寸建渲染器与场景，
 * 尺寸变化会整体重建（旧资源先释放）。每帧都会把底图与可见层重传为纹理，
 * 因此它适合离线逐帧出片，不适合按实时时钟放帧。
 *
 * @param options 合成器参数，缺省 `{}`（id 为 `three`，保留绘制缓冲）
 * @returns 合成器实例；`dispose` 后不可再用
 */
export function createThreeCompositor(
  options: ThreeCompositorOptions = {},
): Compositor {
  /** WebGL 渲染器；尺寸变化时重建 */
  let renderer: WebGLRenderer | null = null;
  /** 合成场景：底图四边形 + 各层四边形 */
  let scene: Scene | null = null;
  /** 像素坐标正交相机：1 单位 = 1 输出像素 */
  let camera: OrthographicCamera | null = null;
  /** 当前输出宽（像素）；0 表示尚未初始化 */
  let width = 0;
  /** 当前输出高（像素）；0 表示尚未初始化 */
  let height = 0;
  /** 当前输出透明度档：决定清屏色与绘制缓冲是否带 alpha */
  let alpha: FrameAlpha = "opaque";
  /** 底图承载；与渲染器同生命周期 */
  let base: Slot | null = null;
  /** 层 id → 承载；按需创建，`dispose` 时整体清空 */
  const slots = new Map<string, Slot>();
  /** 共用的一份单位四边形几何；各网格只改缩放，不各自分配几何 */
  const geometry = new PlaneGeometry(1, 1);

  /**
   * 确保渲染器与场景匹配给定尺寸与输出透明度；两者都不变则直接返回。
   *
   * @param size 目标输出尺寸（像素）与透明度档
   */
  const ensure = (size: {
    width: number;
    height: number;
    alpha?: FrameAlpha;
  }): void => {
    /** 本次要用的透明度档（省略 = 不透明） */
    const nextAlpha: FrameAlpha = size.alpha ?? "opaque";
    if (
      renderer &&
      width === size.width &&
      height === size.height &&
      alpha === nextAlpha
    )
      return;
    dispose();
    width = size.width;
    height = size.height;
    alpha = nextAlpha;
    /** 渲染目标画布：尺寸即输出尺寸，像素比固定为 1 */
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      // 透明档必须让绘制缓冲带 alpha；不透明档关掉它可以省一点带宽
      alpha: alpha === "alpha",
      // 不保留缓冲时，抓帧往往拿到上一帧（甚至空缓冲）
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    // 清屏色是「干净画布」的定义：不透明档清到不透明黑，透明档清到全透明。
    // 两档都必须清，否则上一帧像素会留到这一帧。
    renderer.setClearColor(0x000000, alpha === "alpha" ? 0 : 1);
    renderer.autoClear = true;
    scene = new Scene();
    // 像素坐标系：单位 = 输出像素，方便把任意尺寸的层铺满整幅画面
    camera = new OrthographicCamera(
      -width / 2,
      width / 2,
      height / 2,
      -height / 2,
      -10,
      10,
    );
    camera.position.z = 1;
    base = makeSlot();
    base.texture.colorSpace = SRGBColorSpace;
    base.mesh.renderOrder = -1000;
    scene.add(base.mesh);
  };

  /**
   * 造一块画布承载：贴图 + 透明材质 + 单位四边形网格，网格缩放为输出尺寸。
   *
   * @returns 尚未绑定来源画布的承载
   */
  const makeSlot = (): Slot => {
    /** 贴图：线性过滤、不生成 mipmap，颜色按 sRGB 解释 */
    const texture = new CanvasTexture(document.createElement("canvas"));
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = SRGBColorSpace;
    /** 材质：只做纹理直通，不参与深度测试，透明以便逐层叠加 */
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    /** 网格：缩放为输出尺寸（渲染时按像素坐标铺满整幅画面） */
    const mesh = new Mesh(geometry, material);
    mesh.scale.set(width, height, 1);
    return { mesh, texture, canvas: null };
  };

  /**
   * 把来源画布接到承载上；每帧都要标记 `needsUpdate` 才会重传。
   *
   * @param slot 目标承载
   * @param source 层或底图的来源画布
   */
  const attach = (
    slot: Slot,
    source: HTMLCanvasElement | OffscreenCanvas,
  ): void => {
    if (slot.canvas !== source) {
      // 换画布：CanvasTexture 的 image 可以重绑，但仍要标记重传
      slot.texture.image = source as unknown as HTMLCanvasElement;
      slot.canvas = source;
    }
    slot.texture.needsUpdate = true;
  };

  /**
   * 按层 id 取承载，没有则新建；新建时设置混合方式与渲染次序。
   *
   * @param layer 本帧的一层（读取 `spec.id` / `spec.blend` / `spec.z`）
   * @returns 该层的承载
   */
  const ensureLayer = (layer: FrameLayer): Slot => {
    /** 层 id：承载的复用键 */
    const id = layer.spec.id;
    /** 已存在的承载（同一层跨帧复用） */
    const hit = slots.get(id);
    if (hit) return hit;
    /** 新建的承载：首次出现的层才建，之后跨帧复用 */
    const slot = makeSlot();
    slot.mesh.material.blending =
      layer.spec.blend === "glow" ? AdditiveBlending : NormalBlending;
    slot.mesh.renderOrder = Math.round((layer.spec.z ?? 0) * 10);
    scene!.add(slot.mesh);
    slots.set(id, slot);
    return slot;
  };

  /** 释放全部 GPU 资源并清空尺寸；可重复调用（已释放则为空操作） */
  function dispose(): void {
    for (const slot of slots.values()) {
      slot.mesh.material.dispose();
      slot.texture.dispose();
      slot.mesh.removeFromParent();
    }
    slots.clear();
    if (base) {
      base.mesh.material.dispose();
      base.texture.dispose();
      base.mesh.removeFromParent();
      base = null;
    }
    renderer?.dispose();
    renderer = null;
    scene = null;
    camera = null;
    width = 0;
    height = 0;
  }

  return {
    id: options.id ?? "three",
    begin(size) {
      ensure(size);
    },
    async composite(input: CompositeInput): Promise<FrameHandle> {
      // 透明度由 begin 定，这里沿用当前档位做尺寸校准（不能传 undefined 把它打回不透明）
      ensure({ width: input.width, height: input.height, alpha });
      attach(base!, input.base);
      /** 本帧出现过的层 id：其余承载置为不可见（不销毁，留待下次复用） */
      const seen = new Set<string>();
      for (const layer of input.layers) {
        /** 本层的承载（复用或新建），随后更新可见性与叠放次序 */
        const slot = ensureLayer(layer);
        slot.mesh.visible = true;
        slot.mesh.renderOrder = Math.round((layer.spec.z ?? 0) * 10);
        attach(slot, layer.surface.canvas);
        seen.add(layer.spec.id);
      }
      for (const [id, slot] of slots)
        if (!seen.has(id)) slot.mesh.visible = false;
      renderer!.render(scene!, camera!);
      /** 渲染结果画布：句柄借出，内容在下次渲染时会被覆盖 */
      const canvas = renderer!.domElement;
      return {
        kind: "handle",
        native: canvas,
        width: input.width,
        height: input.height,
        // 画布归合成器所有：这里什么都不用释放
        close() {},
      };
    },
    dispose,
  };
}
