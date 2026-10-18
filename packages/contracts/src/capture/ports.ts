import type { FrameIndex, Ms } from "../shared/units";
import type { LayerDeclaration } from "../scene/layers";

/** 帧载体（CPU 位图最小形态；数据在 CPU 侧可读写，纹理等载体由其上层自行适配） */
export interface FrameBitmap {
  /** 载体形态判别符；省略视为 "bitmap" */
  readonly kind?: "bitmap";
  /** 像素数据（RGBA，每通道 8 位；长度 = width × height × 4） */
  data: Uint8ClampedArray;
  /** 宽（像素） */
  width: number;
  /** 高（像素） */
  height: number;
}

/**
 * 帧载体的另一种形态：**设备句柄**。
 *
 * 句柄不承诺 CPU 可读，只承诺「同一设备内的消费端能把它作为一帧编码或合成」。
 * 它存在的理由只有一个：让 GPU 渲染结果不经 CPU 像素往返就进入编码链路——
 * 一次 1280×720 的 `getImageData` 读数倍于一次绘制，而编码器本来就能直接吃设备侧帧。
 *
 * 约定：
 * - `native` 是不透明底层对象，由渲染后端与消费后端协商（例如 WebCodecs 的 `VideoFrame`、
 *   一块 GPU 纹理、一个离屏画布）；
 * - 所有权随 `writeFrame` 一起转移；接收端若需异步保留，必须自行 `clone()`；
 * - 一个句柄只能 `close()` 一次，重复释放是使用方错误。
 */
export interface FrameHandle {
  /** 载体形态判别符，固定 "handle" */
  readonly kind: "handle";
  /** 不透明底层对象：由渲染后端与消费后端协商 */
  readonly native: unknown;
  /** 宽（像素） */
  readonly width: number;
  /** 高（像素） */
  readonly height: number;
  /** 释放底层资源；一个句柄只能调用一次 */
  close(): void;
}

/**
 * 帧载体：一次推演在某个采样点上的呈现结果。
 *
 * 契约只承诺「可以作为一帧交给消费端」，不承诺像素形态——这正是多种渲染后端
 * （CPU 位图 / GPU 纹理 / DOM 栅格化）能共存于同一条推演链的前提：
 * 后端只决定「怎么画」，不决定「帧是什么」。
 */
export type FrameCarrier = FrameBitmap | FrameHandle;

/**
 * 帧交出点：每帧从这里离开渲染端，渲染之后的一切只认此接口。
 * 变帧率下 index→timestamp 不再是均匀映射，引擎直出真时间戳（采样网格点）。
 * 测试桩与出片后端均实现本契约。
 */
export interface FrameSink {
  /**
   * 写入一帧。
   * @param frame 帧载体（位图或设备句柄）
   * @param index 采样点帧号（0 起）
   * @param timestampMs 该采样点的时间戳（毫秒）
   */
  writeFrame(
    frame: FrameCarrier,
    index: FrameIndex,
    timestampMs: Ms,
  ): void | Promise<void>;
  /** 收尾：全部帧交完后调用一次 */
  finalize(): Promise<void>;
}

/**
 * 帧来源：把「这一刻宿主画面上是什么」取成一帧载体交给引擎。
 * 缺省实现是从 2D 画布回读（同步）；GPU/离屏/自定义合成路径注入自己的实现。
 *
 * 可以返回 Promise：DOM/HTML/React/Vue 这类宿主没有同步抓帧能力（栅格化要等一次
 * 排版与绘制），GPU 读回与跨进程宿主同理。引擎会等待该 Promise 再交帧，
 * 因此异步宿主不会挤掉帧、也不会读到上一帧的半成品。
 *
 * 返回 `FrameHandle` 即表示「本帧不经过 CPU 像素」：引擎不读它的内容，只用它把
 * 这一帧交给 sink，并在 sink 处理完后释放它（见 `FrameHandle` 的所有权约定）。
 *
 * 参数：frame = 采样点帧号（0 起）；timestampMs = 该采样点时间戳（毫秒）。
 */
export type FrameSource = (
  frame: FrameIndex,
  timestampMs: Ms,
) => FrameCarrier | Promise<FrameCarrier>;

/** 一次推演开始时的固定参数：宿主要用它们建舞台、定相机与时间线长度 */
export interface FrameHostInfo {
  /** 采样密度（帧/秒） */
  readonly fps: number;
  /** 画布宽（像素） */
  readonly width: number;
  /** 画布高（像素） */
  readonly height: number;
  /** 整片时长（毫秒） */
  readonly durationMs: Ms;
  /** 是否无呈现出片：不建显示面、只求值与编码 */
  readonly headless: boolean;
  /**
   * 本片声明的画面层（剧本 `env.layer(...)` 的编译产物，绝对故事时间）。
   *
   * 宿主按 `id` 给自己的渲染面配声明：声明说「叠在谁上面、什么时候在」，
   * 渲染面是宿主自己的事。层数由剧本决定，宿主不认识渲染器。
   */
  readonly layers?: readonly LayerDeclaration[];
}

/**
 * 有生命周期的帧宿主：`begin` 建场（每次推演都会调用一次，重播即重置）、
 * `frame` 取当帧位图、`close` 收场（可不实现）。
 *
 * 什么时候需要它：宿主自己持有跨帧状态——物理积分、粒子池、第三方引擎的内部时钟、
 * 需要按 durationMs 预建轨道或缓存贴图的渲染器。纯函数来源（`FrameSource`）没有
 * 这些状态，用函数即可。约定：
 * - `begin` 之后按时间线顺序逐帧调用 `frame`，引擎逐帧等待，**不得并发重入**；
 * - 状态只能在 `begin` 初始化，不得跨 `begin` 沿用——重播与重渲染都从零开始；
 * - `frame` 返回的位图由引擎复制/编码，宿主可以复用同一块缓冲；返回句柄则按
 *   `FrameHandle` 的所有权约定交给引擎释放。
 */
export interface FrameHost {
  /**
   * 建场：每次推演开始时调用一次（重播即重置）。
   * @param info 本次推演的固定参数
   */
  begin(info: FrameHostInfo): void | Promise<void>;
  /**
   * 取当帧画面。
   * @param frame 采样点帧号（0 起）
   * @param timestampMs 该采样点时间戳（毫秒）
   */
  frame(
    frame: FrameIndex,
    timestampMs: Ms,
  ): FrameCarrier | Promise<FrameCarrier>;
  /** 收场：推演结束（成功或失败）后调用；可不实现 */
  close?(): void | Promise<void>;
}

/** 帧像素来源的两种形态：纯函数来源，或带生命周期的宿主 */
export type Painter = FrameSource | FrameHost;
