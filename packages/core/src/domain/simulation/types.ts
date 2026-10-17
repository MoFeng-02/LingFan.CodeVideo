import type {
  AudioOptions,
  FrameState,
  LoopContext,
  Ms,
  Scene,
  SceneEnv,
  SetupEnv,
  StepFn,
  WarpPoint,
} from "@lingfan-video/contracts";

/** 登记期节点树（SceneEnv 回调捕获的中间表示） */
export type SimNode =
  | {
      kind: "step";
      duration: Ms;
      fn: StepFn;
      at?: Ms;
      after?: Ms;
      hold?: boolean;
      fps?: number;
    }
  | { kind: "wait"; duration: Ms }
  | {
      kind: "loop";
      ms?: Ms;
      times?: number;
      fps?: number;
      fn: (ctx: LoopContext) => void;
    }
  | { kind: "par"; children: SimNode[][] }
  | {
      kind: "spawn";
      scene: Scene<unknown>;
      options: {
        key: string;
        at?: Ms;
        duration?: Ms;
        forever?: boolean;
        fps?: number;
      };
      anchor: Ms;
    }
  | { kind: "transition"; next: Scene<unknown>; anchor: Ms }
  | {
      kind: "audio";
      clipUrl: string;
      options: AudioOptions;
      anchor: Ms;
    };

/** 剧本片段运行时形态（Scene 的内部实现：next 由 cutTo/transitionTo 写入） */
export interface SceneInternal<P = unknown> {
  readonly id: string;
  readonly duration: Ms;
  readonly body: (prev: P, env: SceneEnv) => unknown;
  /** cutTo（契约 Scene 实现；createScene 运行时挂载，双重载） */
  cutTo<N>(
    windowMs: Ms,
    body: (prev: P, env: SceneEnv) => N | void,
  ): SceneInternal<N>;
  cutTo<N>(
    _: 0,
    windowSec: number,
    body: (prev: P, env: SceneEnv) => N | void,
  ): SceneInternal<N>;
  readonly setup?: (env: SetupEnv) => Promise<void> | void;
  next?: SceneInternal<unknown>;
  nextIsTransition?: boolean;
}

/** 编译产物：窗口内绝对化的一帧活动单元（step 或一次 loop 迭代） */
export interface CompiledUnit {
  key: string;
  windowStart: Ms;
  windowEnd: Ms;
  hold: boolean;
  /** 本单元有效采样密度（单元声明 > 继承；编译期解析完毕，运行期不再回溯） */
  fps: number;
  /** 回调入参：step 收 StepContext、loop 迭代收 LoopContext（由 runtime 组装） */
  call: (ctx: unknown) => FrameState | void;
  /** loop 迭代元数据（step 无） */
  loop?: { iteration: number; iterationMs?: Ms };
  /** loop 单元的宿主锚点（`loop#N`；stop() 按宿主杀全迭代） */
  loopBase?: string;
  /** 源节点序（同帧绘制顺序 = 登记顺序） */
  order: number;
}

export interface CompiledSpawn {
  key: string;
  scene: Scene<unknown>;
  /** 相对链起点的全局锚点（spawn 在登记流中的 cursor + options.at） */
  startGlobal: Ms;
  chainDuration: Ms;
  forever: boolean;
  /** 链级基础帧率（链内单元未声明 fps 时继承；undefined = 引擎基础帧率） */
  chainFps?: number;
}

export interface CompiledAudio {
  clipUrl: string;
  atMs: Ms;
  volume: number;
  fadeIn?: Ms;
  fadeOut?: Ms;
  loop: boolean;
  /** 目标声道数（undefined = 跟随源声道布局） */
  channels?: number;
  /** 立体声摆位 -1~1（缺省 0 居中） */
  pan: number;
  /** 时间映射锚点（atMs 相对事件起点；undefined = 原速） */
  warp?: readonly WarpPoint[];
}

/** 单段编译结果（衔接下一片段由 runtime 链式推进） */
export interface CompiledSegment {
  sceneId: string;
  duration: Ms;
  units: CompiledUnit[];
  spawns: CompiledSpawn[];
  audio: CompiledAudio[];
  /** transitionTo 提前收窗（其后节点不活跃）；undefined = 跑满 duration */
  activeEnd?: Ms;
  /** transitionTo 的目标片段（由 compile 从节点流透出，runtime 链式推进用） */
  transitionNext?: unknown;
  /** body 返回值（成为链上下一幕 body 的 prev 参数） */
  bodyResult: unknown;
}

/** 池消耗账本（总毫秒池 = 各段窗口期之和；此处算段内帧窗池） */
export function poolOf(nodes: SimNode[]): Ms {
  let cursor = 0;
  for (const n of nodes) {
    if (n.kind === "step" || n.kind === "wait") cursor += n.duration;
    else if (n.kind === "loop") cursor += loopPool(n);
    else if (n.kind === "par") cursor += Math.max(0, ...n.children.map(poolOf));
  }
  return cursor;
}

/** loop 池消耗：ms×times / ms 到段尾由调用方夹取 / 无 ms = 0（自管节奏不占池） */
export function loopPool(n: { ms?: Ms; times?: number }): Ms {
  if (n.ms === undefined) return 0;
  return n.times === undefined ? n.ms : n.ms * n.times;
}
