import type {
  AudioClip,
  AudioOptions,
  LoopSpec,
  Ms,
  Scene,
  SceneEnv,
  SpawnOptions,
  StepFn,
  StepOptions,
} from "@lingfan-video/contracts";
import { loop as loopUntil } from "../audio";
import type { SceneInternal, SimNode } from "./types";

let sceneSeq = 0;

/**
 * Scene 的工厂：闭包注入 cutTo 双重载（Ms 糖 / 秒糖），返回不可变链节点。
 * 两种 body 形状都收：不读上一幕就只接 env（spawn/cutTo 目标的常见写法），
 * 需要上一幕状态时显式写 (prev, env)。
 */
export function createScene<P>(
  duration: Ms,
  body: (prev: P, env: SceneEnv) => unknown,
  setup?: SceneInternal<P>["setup"],
): SceneInternal<P> {
  const id = `scene#${sceneSeq++}`;
  const scene = { id, duration, body, setup } as SceneInternal<P>; // cutTo 挂载前先断言（方法由下方补齐）
  (scene as { cutTo?: unknown }).cutTo = ((...args: unknown[]) => {
    // (windowMs, body) 或 (_, 0, windowSec, body)
    let windowMs: Ms;
    let childBody: (prev: unknown, env: SceneEnv) => unknown;
    if (args.length === 3) {
      windowMs = (args[1] as number) * 1000;
      childBody = args[2] as (prev: unknown, env: SceneEnv) => unknown;
    } else {
      windowMs = args[0] as Ms;
      childBody = args[1] as (prev: unknown, env: SceneEnv) => unknown;
    }
    if (scene.next)
      throw new Error(
        `spec_violation: ${id} 重复链接（cutTo/transitionTo 只能一个出口）`,
      );
    const child = createScene(windowMs, childBody);
    scene.next = child;
    return child as unknown as Scene<unknown>;
  }) as unknown;
  return scene;
}

/**
 * 登记器：把 SceneEnv 调用捕获为 SimNode 流。
 * cursor 只被 step/wait/par 推进；loop/spawn/transition/audio 不推进 cursor。
 */
export class Recorder implements SceneEnv {
  readonly nodes: SimNode[] = [];
  cursor: Ms = 0;
  order = 0;
  readonly f: SceneEnv["f"];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly fps: number,
    readonly headless: boolean,
    readonly canvas: SceneEnv["canvas"],
  ) {
    this.f = (n: number) => (n * 1000) / fps;
  }

  step(a: StepFn | Ms, b?: StepFn | StepOptions, c?: StepOptions): void {
    let node: Extract<SimNode, { kind: "step" }>;
    if (typeof a === "function") {
      const opts = (b ?? {}) as StepOptions;
      // 默认时长 = 声明帧率下的一帧（未声明 = 基础帧率一帧）
      const fps = opts.fps ?? this.fps;
      node = { kind: "step", duration: 1000 / fps, fn: a, ...opts };
    } else {
      const opts = (c ?? {}) as StepOptions;
      node = { kind: "step", duration: a, fn: b as StepFn, ...opts };
    }
    this.nodes.push(node);
    this.cursor += node.duration;
  }

  loop(spec: LoopSpec): void {
    this.nodes.push({
      kind: "loop",
      ms: spec.ms,
      times: spec.times,
      fps: spec.fps,
      fn: spec.fn,
    });
  }

  par(children: Array<(branch: SceneEnv) => void>): void {
    // 子作用域共享起点、各自推进；一个 par 节点带分支列表，池消耗 = max
    const subs = children.map(
      () =>
        new Recorder(
          this.width,
          this.height,
          this.fps,
          this.headless,
          this.canvas,
        ),
    );
    children.forEach((thunk, i) => thunk(subs[i]!)); // 分支 env 显式传入（闭包捕获外层 env 不构成分支）
    let pool: Ms = 0;
    for (const sub of subs) pool = Math.max(pool, sub.cursor);
    this.nodes.push({ kind: "par", children: subs.map((s) => s.nodes) });
    this.cursor += pool;
  }

  spawn<S>(
    scene: Scene<S>,
    options: SpawnOptions,
  ): import("@lingfan-video/contracts").Handle {
    this.nodes.push({
      kind: "spawn",
      scene: scene as Scene<unknown>,
      options,
      anchor: this.cursor,
    });
    // 登记期无运行句柄（占位 Handle；运行期句柄来自 StepContext.spawn）
    return {
      kill() {},
      dispose() {},
      get alive() {
        return false;
      },
      localTime: 0,
      duration: 0,
    };
  }

  wait(duration: Ms): void {
    this.nodes.push({ kind: "wait", duration });
    this.cursor += duration;
  }

  transitionTo(next: Scene<unknown>): void {
    // 只登记 anchor（提前收窗点）；next 的链接语义由 compile 消费
    this.nodes.push({ kind: "transition", next, anchor: this.cursor });
  }

  audio(clip: AudioClip, options?: AudioOptions): void {
    // 登记期是「声明」：起点 = 当前登记位置 + at；运行期操作面在 ctx.audio
    this.nodes.push({
      kind: "audio",
      clip,
      options: options ?? {},
      anchor: this.cursor,
    });
  }

  bgm(clip: AudioClip, options?: Omit<AudioOptions, "loop">): void {
    // bgm 糖：循环到时间线尾（要定制循环区间请用 audio + loop(untilMs)）
    this.audio(clip, { ...options, loop: loopUntil() });
  }
}

export interface StartSpec<P> {
  window: Ms;
  setup?: SceneInternal<P>["setup"];
  run: (env: SceneEnv) => P | void;
}

/** start 三重载 → SceneInternal（windowMs/body、秒糖、spec 形式） */
export function startScene<P>(
  windowMs: Ms,
  body: (env: SceneEnv) => P | void,
): SceneInternal<P>;
export function startScene<P>(
  _: 0,
  windowSec: number,
  body: (env: SceneEnv) => P | void,
): SceneInternal<P>;
export function startScene<P>(spec: StartSpec<P>): SceneInternal<P>;
export function startScene<P>(...args: unknown[]): SceneInternal<P> {
  if (args.length === 1) {
    const spec = args[0] as StartSpec<P>;
    return createScene<P>(
      spec.window,
      (_prev, env) => spec.run(env),
      spec.setup as SceneInternal<P>["setup"],
    );
  }
  if (args.length === 2) {
    const [windowMs, body] = args as [Ms, (env: SceneEnv) => P | void];
    return createScene<P>(windowMs, (_prev, env) => body(env));
  }
  const [, windowSec, body] = args as [0, number, (env: SceneEnv) => P | void];
  return createScene<P>(windowSec * 1000, (_prev, env) => body(env));
}
