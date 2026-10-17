import type { Ms } from "../shared/units";
import type { Handle, SpawnOptions } from "../scheduler";
import type { AudioClipRef, AudioOptions } from "../audio";
import type { LoopSpec, StepFn, StepOptions } from "./nodes";

/** 帧号换算糖：f(n) = n × (1000 / 单元有效帧率)——单元内语义，跨单元不可比 */
export type FrameFn = (frameNumber: number) => Ms;

/** 画布环境（登记与逐帧上下文共享的部分） */
export interface CanvasEnv {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  f: FrameFn;
}

/**
 * 登记阶段环境。
 * 设计决定：step/loop/par/wait/transitionTo 以 SceneEnv 成员形式提供——
 * 显式上下文、避免隐式注册作用域。
 */
export interface SceneEnv extends CanvasEnv {
  fps: number;
  headless: boolean;
  /** 显式时长形式 */
  step(duration: Ms, fn: StepFn, options?: StepOptions): void;
  /** 默认时长形式（单帧；检查时机 = 契约符合性检查） */
  step(fn: StepFn, options?: StepOptions): void;
  /** loop 统一对象参数 {ms?, times?, fn} */
  loop(spec: LoopSpec): void;
  /** 分支显式接分支 env（闭包捕获外层 env 不构成分支） */
  par(children: Array<(branch: SceneEnv) => void>): void;
  /** key 必填（同 key 去重 = 跨段续接） */
  spawn<S>(scene: Scene<S>, options: SpawnOptions): Handle;
  wait(duration: Ms): void;
  transitionTo(next: Scene<unknown>): void;
  /** 音频：不消耗帧窗池、不改 step 模型 */
  audio(clip: AudioClipRef, options?: AudioOptions): void;
  bgm(clip: AudioClipRef, options?: Omit<AudioOptions, "at">): void;
}

/** setup 阶段环境：资产解码同位进 setup；run 阶段拿不到 assets */
export interface SetupEnv extends SceneEnv {
  assets: AssetHooks;
}

/** 资产钩子（当前版本仅 load；generate + 缓存规则后续版本接入） */
export interface AssetHooks {
  load(url: string): Promise<AssetLike>;
}

/** 资产最小形态（ImageBitmap / AudioBuffer 等由适配器具体化） */
export interface AssetLike {
  readonly url: string;
  readonly kind: "image" | "audio" | "data";
}

/** 剧本片段：不可变链，cutTo 返回新片段 */
export interface Scene<P = unknown> {
  readonly id: string;
  readonly duration: Ms;
  /** body 显式接上一幕状态；返回值成为下一幕 params */
  cutTo<N>(windowMs: Ms, body: (prev: P, env: SceneEnv) => N | void): Scene<N>;
  /** 秒糖重载：首参字面量 0 标记秒单位 */
  cutTo<N>(
    _: 0,
    windowSec: number,
    body: (prev: P, env: SceneEnv) => N | void,
  ): Scene<N>;
}

/** start 签名：body 返回 P | void（返回值成为下一幕 params） */
export interface StartFn {
  <P>(windowMs: Ms, body: (env: SceneEnv) => P | void): Scene<P>;
  <P>(_: 0, windowSec: number, body: (env: SceneEnv) => P | void): Scene<P>;
  <P>(spec: StartSpec<P>): Scene<P>;
}

/** spec 形式：setup 只跑一次（资产/解码），run 为登记体 */
export interface StartSpec<P> {
  window: Ms;
  setup?: (env: SetupEnv) => Promise<void> | void;
  run: (env: SceneEnv) => P | void;
}
