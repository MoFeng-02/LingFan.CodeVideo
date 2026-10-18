import type {
  FrameIndex,
  LoopContext,
  Ms,
  RandomStream,
  RenderError,
  StepContext,
  WaitContext,
} from "@lingfan-video/contracts";
import type {
  CompiledUnit,
  SceneInternal,
} from "../../../domain/simulation/types";
import { makeRenderError } from "../error";
import type { ChainSpan, EvalDeps, SpawnChain } from "../engine-types";
import { dynamicSpawn, schedulerFacade } from "../spawn-handle";
import { randomLabel, unitRandomStream } from "../random";
import { audioOf, graphOf, onceOf, selfDisposeOf } from "./capabilities";
import type { DisposalInfo } from "./disposal";

/** 单元随机子流：同一单元实例一条；spawn 出来的实例各走各的子流 */
function randomOf(
  deps: EvalDeps,
  unit: CompiledUnit,
  chain: SpawnChain | null,
): RandomStream {
  return unitRandomStream(
    deps.state,
    randomLabel(unit.key, chain?.key ?? null),
  );
}

function wrapThrow(e: unknown, sceneId: string, t: Ms, what: string): never {
  if ((e as RenderError).kind) throw e;
  throw makeRenderError(
    "step_throw",
    sceneId,
    t,
    `${what}回调抛错：${(e as Error).message}`,
  );
}

/**
 * 执行回调（同时也是音频句柄操作的合法窗口）：
 * 返回值是 FrameState 则发布（经 key 化聚合），否则无状态发布。
 */
export function invoke(
  deps: EvalDeps,
  span: ChainSpan,
  unit: CompiledUnit,
  ctx: unknown,
  t: Ms,
): void {
  const { state, aggregator } = deps;
  state.inCallback = true;
  try {
    const published = (unit.call as (c: unknown) => unknown)(ctx);
    if (published && typeof published === "object")
      aggregator.publish(
        `${span.scene.id}/${unit.key}`,
        published as Record<string, unknown>,
      );
  } catch (e) {
    wrapThrow(e, span.scene.id, t, `step（${unit.key}）`);
  } finally {
    state.inCallback = false;
  }
}

/** step 单元：StepContext + FrameState 发布 */
export function evalStep(
  deps: EvalDeps,
  span: ChainSpan,
  unit: CompiledUnit,
  f: FrameIndex,
  t: Ms,
  localIn: Ms,
  chain: SpawnChain | null,
  hostKey: string,
  disp: DisposalInfo,
): void {
  const { opts } = deps.state;
  const { width, height, canvas } = opts;
  const duration = unit.windowEnd - unit.windowStart;
  // f(n)/deltaTime 以本单元有效帧率为基准（单元内语义，编译期已解析定死）
  const uf = unit.fps;
  const ctx: StepContext = {
    canvas,
    width,
    height,
    f: (n: number) => (n * 1000) / uf,
    t,
    frameIndex: f,
    totalTime: deps.state.timelineEnd,
    input: deps.state.nowInput,
    random: randomOf(deps, unit, chain),
    fps: uf,
    deltaTime: 1000 / uf,
    localT: localIn,
    duration,
    progress: duration > 0 ? localIn / duration : 0,
    spawn: (scene, options) =>
      dynamicSpawn(deps, scene as SceneInternal<unknown>, options, t, chain),
    scheduler: schedulerFacade(deps.state, t),
    ...audioOf(deps, t),
    ...graphOf(deps, t),
    disposing: disp.disposing,
    disposeProgress: disp.progress,
    dispose: selfDisposeOf(deps, t, hostKey),
    once: onceOf(deps, t, span.scene.id, hostKey, chain, undefined),
  };
  invoke(deps, span, unit, ctx, t);
}

/** loop 预展开迭代单元：LoopContext（iteration/iterationT/iterationProgress） */
export function evalLoopIter(
  deps: EvalDeps,
  span: ChainSpan,
  unit: CompiledUnit,
  f: FrameIndex,
  t: Ms,
  localIn: Ms,
  chain: SpawnChain | null,
  hostKey: string,
  disp: DisposalInfo,
): void {
  const { width, height, canvas } = deps.state.opts;
  const iterMs = unit.loop!.iterationMs!;
  const uf = unit.fps;
  const ctx: LoopContext = {
    canvas,
    width,
    height,
    f: (n: number) => (n * 1000) / uf,
    parentT: t - span.start,
    frameIndex: f,
    input: deps.state.nowInput,
    random: randomOf(deps, unit, chain),
    fps: uf,
    deltaTime: 1000 / uf,
    iteration: unit.loop!.iteration,
    iterationT: localIn,
    iterationProgress: iterMs > 0 ? localIn / iterMs : 0,
    next: () => {}, // 迭代已预展开，next 无操作
    stop: () => deps.state.deadUnits.add(hostKey), // 杀宿主=全迭代终止
    spawn: (scene, options) =>
      dynamicSpawn(deps, scene as SceneInternal<unknown>, options, t, chain),
    scheduler: schedulerFacade(deps.state, t),
    ...audioOf(deps, t),
    ...graphOf(deps, t),
    disposing: disp.disposing,
    disposeProgress: disp.progress,
    dispose: selfDisposeOf(deps, t, hostKey),
    once: onceOf(deps, t, span.scene.id, hostKey, chain, unit.loop!.iteration),
  };
  invoke(deps, span, unit, ctx, t);
}

/**
 * wait 回调单元：自身不产帧，只在其他单元产帧的网格点上被调用。
 * 能力集刻意不含画布与产帧原语——见 contracts WaitContext。
 */
export function evalWait(
  deps: EvalDeps,
  span: ChainSpan,
  unit: CompiledUnit,
  f: FrameIndex,
  t: Ms,
  localIn: Ms,
  hostKey: string,
  disp: DisposalInfo,
): void {
  const duration = unit.windowEnd - unit.windowStart;
  const ctx: WaitContext = {
    t,
    frameIndex: f,
    totalTime: deps.state.timelineEnd,
    input: deps.state.nowInput,
    random: randomOf(deps, unit, null),
    localT: localIn,
    duration,
    progress: duration > 0 ? localIn / duration : 0,
    scheduler: schedulerFacade(deps.state, t),
    ...audioOf(deps, t),
    ...graphOf(deps, t),
    disposing: disp.disposing,
    disposeProgress: disp.progress,
    dispose: selfDisposeOf(deps, t, hostKey),
    once: onceOf(deps, t, span.scene.id, hostKey, null, undefined),
  };
  deps.state.inCallback = true;
  try {
    unit.onUpdate!(ctx);
  } catch (e) {
    wrapThrow(e, span.scene.id, t, `wait（${unit.key}）`);
  } finally {
    deps.state.inCallback = false;
  }
}

/** loop 未给 ms（自管节奏）：逐帧活跃，ctx.next() 推进 iteration、stop() 终止 */
export function evalSelfPacedLoop(
  deps: EvalDeps,
  span: ChainSpan,
  unit: CompiledUnit,
  f: FrameIndex,
  t: Ms,
  localT: Ms,
  chain: SpawnChain | null,
  deadKey: string,
  hostKey: string,
  disp: DisposalInfo,
): void {
  const { width, height, canvas } = deps.state.opts;
  const cur = deps.state.selfPaced.get(deadKey) ?? {
    iteration: 0,
    iterStart: localT,
  };
  if (!deps.state.selfPaced.has(deadKey))
    deps.state.selfPaced.set(deadKey, cur);
  const uf = unit.fps;
  const ctx: LoopContext = {
    canvas,
    width,
    height,
    f: (n: number) => (n * 1000) / uf,
    parentT: t - span.start,
    frameIndex: f,
    input: deps.state.nowInput,
    random: randomOf(deps, unit, chain),
    fps: uf,
    deltaTime: 1000 / uf,
    iteration: cur.iteration,
    iterationT: localT - cur.iterStart,
    iterationProgress: 0, // 无迭代时长：进度自管
    next: () => {
      cur.iteration += 1;
      cur.iterStart = localT;
    },
    stop: () => deps.state.deadUnits.add(hostKey),
    spawn: (scene, options) =>
      dynamicSpawn(deps, scene as SceneInternal<unknown>, options, t, chain),
    scheduler: schedulerFacade(deps.state, t),
    ...audioOf(deps, t),
    ...graphOf(deps, t),
    disposing: disp.disposing,
    disposeProgress: disp.progress,
    dispose: selfDisposeOf(deps, t, hostKey),
    once: onceOf(deps, t, span.scene.id, hostKey, chain, cur.iteration),
  };
  invoke(deps, span, unit, ctx, t);
}
