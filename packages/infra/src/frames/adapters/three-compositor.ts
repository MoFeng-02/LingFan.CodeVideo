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
 * 会把主线程吃干净（实测一次 JS 调用被阻塞分钟级，页面直接失联）。
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
import type { FrameHandle } from "@lingfan-video/contracts";
import type { CompositeInput, Compositor, FrameLayer } from "../types";

export interface ThreeCompositorOptions {
  /** 画布 id，缺省 `three` */
  readonly id?: string;
  /** 保留绘制缓冲：抓帧（VideoFrame）与贴回舞台都需要渲染结果可读 */
  readonly preserveDrawingBuffer?: boolean;
}

interface Slot {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly texture: CanvasTexture;
  /** 上一帧画布身份：换了画布要换贴图源 */
  canvas: HTMLCanvasElement | OffscreenCanvas | null;
}

export function createThreeCompositor(
  options: ThreeCompositorOptions = {},
): Compositor {
  let renderer: WebGLRenderer | null = null;
  let scene: Scene | null = null;
  let camera: OrthographicCamera | null = null;
  let width = 0;
  let height = 0;
  let base: Slot | null = null;
  const slots = new Map<string, Slot>();
  const geometry = new PlaneGeometry(1, 1);

  const ensure = (size: { width: number; height: number }): void => {
    if (renderer && width === size.width && height === size.height) return;
    dispose();
    width = size.width;
    height = size.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      // 不保留缓冲时，抓帧往往拿到上一帧（甚至空缓冲）
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 1);
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

  const makeSlot = (): Slot => {
    const texture = new CanvasTexture(document.createElement("canvas"));
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.scale.set(width, height, 1);
    return { mesh, texture, canvas: null };
  };

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

  const ensureLayer = (layer: FrameLayer): Slot => {
    const id = layer.spec.id;
    const hit = slots.get(id);
    if (hit) return hit;
    const slot = makeSlot();
    slot.mesh.material.blending =
      layer.spec.blend === "glow" ? AdditiveBlending : NormalBlending;
    slot.mesh.renderOrder = Math.round((layer.spec.z ?? 0) * 10);
    scene!.add(slot.mesh);
    slots.set(id, slot);
    return slot;
  };

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
      ensure({ width: input.width, height: input.height });
      attach(base!, input.base);
      const seen = new Set<string>();
      for (const layer of input.layers) {
        const slot = ensureLayer(layer);
        slot.mesh.visible = true;
        slot.mesh.renderOrder = Math.round((layer.spec.z ?? 0) * 10);
        attach(slot, layer.surface.canvas);
        seen.add(layer.spec.id);
      }
      for (const [id, slot] of slots)
        if (!seen.has(id)) slot.mesh.visible = false;
      renderer!.render(scene!, camera!);
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
