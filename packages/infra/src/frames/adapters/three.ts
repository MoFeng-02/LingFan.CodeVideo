/**
 * three.js 适配器：把「three 画的一层画面」接成 infra 的 `LayerSurface`。
 *
 * 它只负责**画这一层**，不负责合成——合成由 infra 的合成器做（`canvas2d` 用 `drawImage`，
 * GPU 合成器 `three-compositor` 用四边形叠）。这样换渲染包只改这一个文件：
 * 别的渲染包（其它 WebGPU 包、自研 GL、DOM 栅格化）写同形的 `LayerSurface` 即可。
 *
 * 为什么放在子目录：引擎与契约都不认识 three，`frames` 目录只定义接缝；
 * 导入走 `@lingfan-video/infra/frames/adapters/three` 子路径，
 * 不用 GPU 的调用方不会被拖进这个依赖。
 */
import {
  OrthographicCamera,
  type Camera,
  type PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import type { FrameIndex, Ms } from "@lingfan-video/contracts";
import type { FrameLayer, LayerSpec } from "../types";

/** three 渲染器只要能画、能交画布即可；换成 WebGPU 渲染器时同形 */
export interface ThreeRendererLike {
  /** 渲染器自带的画布：适配器把它的内容当成本层输出 */
  domElement: HTMLCanvasElement;
  /**
   * 设置渲染尺寸。
   *
   * @param width 宽（像素）
   * @param height 高（像素）
   * @param updateStyle 是否同时改 CSS 尺寸；离屏渲染传 `false`
   */
  setSize(width: number, height: number, updateStyle?: boolean): void;
  /**
   * 渲染一帧到画布。
   *
   * @param scene 场景
   * @param camera 相机
   */
  render(scene: Scene, camera: Camera): void;
  /** 释放渲染器持有的 GPU 资源（上下文、缓冲）；由层 `dispose` 调用 */
  dispose(): void;
}

/** 造一层 three 内容所需的参数 */
export interface ThreeLayerOptions {
  /** 层声明：id、叠放次序与可见区间（合成端只看这些） */
  readonly spec: LayerSpec;
  /** 承载面宽（像素），同时作为画布初始宽度 */
  readonly width: number;
  /** 承载面高（像素），同时作为画布初始高度 */
  readonly height: number;
  /** 造渲染器（例如 `three/webgpu` 的 WebGPURenderer）；缺省 WebGLRenderer */
  readonly createRenderer?: (canvas: HTMLCanvasElement) => ThreeRendererLike;
  /**
   * 造相机：缺省是与底图同坐标的正交相机；三维内容给一个透视相机即可。
   * 相机归层所有，`build` / `update` 里可以直接动它。
   */
  readonly createCamera?: (size: {
    width: number;
    height: number;
  }) => PerspectiveCamera | OrthographicCamera;
  /**
   * 建立内容：拿到场景与相机后往里加东西。
   * 只在层第一次真正要画时调用，所以可以放心按需建对象。
   */
  readonly build: (context: {
    scene: Scene;
    camera: PerspectiveCamera | OrthographicCamera;
    canvas: HTMLCanvasElement;
  }) => void;
  /** 每帧更新（拿到故事时间与帧序号）；纯静态层可以不写 */
  readonly update?: (
    t: Ms,
    frame: FrameIndex,
    context: { scene: Scene; camera: Camera },
  ) => void;
  /** 拆对象（贴图/几何/材质） */
  readonly dispose?: () => void;
}

/**
 * three 内容层：自己一块画布，`render` 时把这一帧画进去。
 * 合成器只认它的画布，不认识 three——别的渲染包写同形的 `LayerSurface` 即可替换。
 *
 * 惰性初始化：画布在调用时就建好（尺寸固定），渲染器/场景/相机要等第一次
 * `render` 才创建，因此没上屏的层不占 GPU 资源。默认 WebGL 渲染器开
 * `preserveDrawingBuffer` 且带 alpha，保证这一层的画布能被合成器再读一次。
 *
 * @param options 层声明、尺寸与建场景的回调
 * @returns 可直接交给合成器的 `FrameLayer`
 */
export function createThreeLayer(options: ThreeLayerOptions): FrameLayer {
  /** 本层自己的画布：尺寸由 options 决定，之后不再变 */
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  /** 渲染器；首次 `render` 时创建，`dispose` 后置回 `null` */
  let renderer: ThreeRendererLike | null = null;
  /** 场景；与渲染器同生命周期 */
  let scene: Scene | null = null;
  /** 相机；与渲染器同生命周期，`update` 里可被直接修改 */
  let camera: Camera | null = null;

  /** 首次渲染前的一次性初始化：建渲染器、场景、相机并调用 `build` */
  const setup = (): void => {
    if (renderer) return;
    renderer = options.createRenderer
      ? options.createRenderer(canvas)
      : new WebGLRenderer({
          canvas,
          antialias: false,
          // 透明背景：这一层只交自己画的东西，合成时由合成器叠加。
          alpha: true,
          preserveDrawingBuffer: true,
        });
    renderer.setSize(options.width, options.height, false);
    scene = new Scene();
    if (options.createCamera) {
      camera = options.createCamera({
        width: options.width,
        height: options.height,
      });
    } else {
      // 与底图同一套设计坐标：640×360 设计单元按 height/360 放大
      /** 缺省正交相机：视野正好覆盖输出像素范围，z=10 让常见图层落在近远平面之间 */
      const ortho = new OrthographicCamera(
        -options.width / 2,
        options.width / 2,
        options.height / 2,
        -options.height / 2,
        0,
        100,
      );
      ortho.position.z = 10;
      camera = ortho;
    }
    options.build({
      scene,
      camera: camera as PerspectiveCamera | OrthographicCamera,
      canvas,
    });
  };

  return {
    spec: options.spec,
    surface: {
      id: options.spec.id,
      width: options.width,
      height: options.height,
      canvas,
      render(frame: FrameIndex, timestampMs: Ms) {
        setup();
        options.update?.(timestampMs, frame, {
          scene: scene!,
          camera: camera!,
        });
        renderer!.render(scene!, camera!);
      },
      dispose() {
        options.dispose?.();
        renderer?.dispose();
        renderer = null;
        scene = null;
        camera = null;
      },
    },
  };
}
