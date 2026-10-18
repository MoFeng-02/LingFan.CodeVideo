/**
 * 帧合成的类型接缝：层的声明、渲染后端的承载面、一次合成的输入与合成器接口。
 *
 * 这一层只说「要叠什么、由谁画、怎么交出去」，不绑定具体渲染技术：
 * 承载面是一块画布（2D / WebGL / WebGPU 都行），合成器只认画布，
 * 交出的结果是设备侧帧载体（零拷贝，不回读 CPU 像素）。
 */
import type { FrameIndex, Ms } from "@lingfan-video/contracts";

/**
 * 一层画面在时间线上的可见区间（左闭右开，故事时间毫秒）。
 * 不给 `from`/`to` 表示整段可见——区间是剧本语义，不是后端参数。
 */
export interface LayerSpan {
  /** 可见区间起点（毫秒，含）；缺省 = 从本段起点开始 */
  readonly from?: Ms;
  /** 可见区间终点（毫秒，不含）；缺省 = 到本段结束 */
  readonly to?: Ms;
}

/** 一层的声明：次序与可见区间。层的内容由 `LayerSurface` 负责画。 */
export interface LayerSpec extends LayerSpan {
  /** 层 id：与剧本里登记的层声明配对用的键 */
  readonly id: string;
  /** 叠放次序，升序在下面；缺省按声明顺序 */
  readonly z?: number;
  /** 合成方式：`glow` 为叠加（光效层），缺省为普通 alpha 叠放 */
  readonly blend?: "normal" | "glow";
}

/**
 * 一个渲染后端的承载面：自己一块画布，负责把「这一帧」画进去。
 *
 * 这是「N 后端可组合」的接缝：后端可以是 2D 画布、WebGL2、WebGPU 或任何
 * 能把结果放进一块画布的渲染器；合成器不需要认识它们，只认识这块画布。
 */
export interface LayerSurface {
  /** 层 id，与 `LayerSpec.id` 对应 */
  readonly id: string;
  /** 承载面宽（像素），与本段输出尺寸一致 */
  readonly width: number;
  /** 承载面高（像素），与本段输出尺寸一致 */
  readonly height: number;
  /** 层自己的画布：合成器只认这块画布，不认识它背后是什么渲染器 */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /**
   * 把本帧内容画进自己的画布（同步提交即可，不必等 GPU 完成）。
   *
   * 合成器在画之前不会替这一层清屏，需要清就让实现自己清。
   *
   * @param frame 帧号（从 0 开始）
   * @param timestampMs 本帧时间戳（毫秒）
   */
  render(frame: FrameIndex, timestampMs: Ms): void;
  /** 释放该层持有的设备资源（纹理 / 画布）；由所属合成器或宿主在收尾时调用一次 */
  dispose?(): void;
}

/** 合成本帧时的一层：声明（决定叠放与可见性）+ 承载面（负责画） */
export interface FrameLayer {
  /** 该层的声明，`planComposite` 只看它 */
  readonly spec: LayerSpec;
  /** 该层的渲染承载面 */
  readonly surface: LayerSurface;
}

/** 合成一次的输入：底图（引擎画布，CPU 2D 内容已画好）+ 本帧要叠的层 */
export interface CompositeInput {
  /** 底图：引擎已画好的画布，尺寸应与 `width` / `height` 一致 */
  readonly base: HTMLCanvasElement | OffscreenCanvas;
  /** 本帧要叠的层，自下而上（通常来自 `planComposite`） */
  readonly layers: readonly FrameLayer[];
  /** 本帧帧号（从 0 开始） */
  readonly frame: FrameIndex;
  /** 本帧时间戳（毫秒） */
  readonly timestampMs: Ms;
  /** 输出宽（像素） */
  readonly width: number;
  /** 输出高（像素） */
  readonly height: number;
}

/**
 * 合成器：把底图与若干层合成成一帧，交出**设备侧**帧载体。
 * 交出的载体是 `FrameHandle`——不经过 CPU 像素，这是零拷贝的落点。
 */
export interface Compositor {
  /** 合成器标识（能力探测与日志用，如 `canvas2d` / `three`） */
  readonly id: string;
  /**
   * 初始化或重新适配输出尺寸。
   *
   * 可以在同一个实例上多次调用以换尺寸；返回 Promise 表示后端初始化是异步的
   * （如 GPU 设备请求），调用方要 await 后再 `composite`。
   *
   * @param size 输出尺寸（像素）
   */
  begin(size: { width: number; height: number }): void | Promise<void>;
  /**
   * 合成一帧并交出设备侧载体。
   *
   * 载体内的 `native` 归合成器所有：`close()` 由消费端调用一次，但不必
   * 真正释放资源（画布/纹理由合成器复用），调用后该载体不应再被使用。
   *
   * @param input 本帧的底图、层与尺寸
   * @returns 设备侧帧句柄（`kind: "handle"`）
   */
  composite(
    input: CompositeInput,
  ): Promise<import("@lingfan-video/contracts").FrameHandle>;
  /**
   * 释放合成器自身持有的资源（画布、GPU 纹理、上下文）。
   *
   * 不负责各层 `LayerSurface` 的释放——那些由层的所有者收尾。
   */
  dispose(): void;
}
