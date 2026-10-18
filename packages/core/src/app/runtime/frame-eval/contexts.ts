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
 *
 * 回调抛出的非 RenderError 会包装成 `step_throw`，并带上场景与时刻定位。
 *
 * @param deps 求值依赖（聚合表与引擎状态）
 * @param span 当前段窗口（提供场景 id）
 * @param unit 当前单元（提供回调与单元键）
 * @param ctx 按单元形态装配好的上下文（StepContext / LoopContext）
 * @param t 当前求值时刻（时间线毫秒，仅用于错误定位）
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

/**
 * step 单元：StepContext + FrameState 发布。
 *
 * `f(n)` 与 `deltaTime` 以本单元的有效帧率为基准（单元内语义，编译期已定死）：
 * 单元声明 fps > spawn 链继承 fps > 引擎基础 fps。
 *
 * @param deps 求值依赖
 * @param span 当前段窗口（提供场景 id 与窗口起点）
 * @param unit 当前单元（窗口、有效帧率、回调）
 * @param f 帧序号（引擎交帧的全局帧号，从 0 起）
 * @param t 全局时间线时刻（毫秒）
 * @param localIn 单元内相对时刻（毫秒）= localT − windowStart
 * @param chain 所属 spawn 链；主链单元传 `null`
 * @param hostKey 宿主键（`sceneId/unitKey`，loop 为宿主锚点）
 * @param disp 消亡窗口状态（disposing / 0..1 进度）
 */
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

/**
 * loop 预展开迭代单元：LoopContext（iteration/iterationT/iterationProgress）。
 *
 * 迭代在编译期已展开成独立单元窗口，所以 `next()` 是空操作：
 * 推进迭代由「下一帧落在下一个单元的窗口里」完成，`stop()` 杀宿主键即终止全部迭代。
 *
 * @param deps 求值依赖
 * @param span 当前段窗口
 * @param unit 当前单元（必须带 `loop` 与 `iterationMs`）
 * @param f 帧序号（全局帧号，从 0 起）
 * @param t 全局时间线时刻（毫秒）
 * @param localIn 本迭代内相对时刻（毫秒）
 * @param chain 所属 spawn 链；主链单元传 `null`
 * @param hostKey 宿主键（loop 宿主锚点，`stop()` 用它杀全迭代）
 * @param disp 消亡窗口状态
 */
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
 *
 * wait 单元本身不贡献采样点，所以它看到的是「别人产帧的那些时刻」：
 * 同一帧里所有单元共享同一份输入快照与同一个帧号。
 *
 * @param deps 求值依赖
 * @param span 当前段窗口
 * @param unit 当前单元（必须带 `onUpdate`）
 * @param f 帧序号（全局帧号，从 0 起；它与产帧单元共享同一帧号）
 * @param t 全局时间线时刻（毫秒）
 * @param localIn 单元内相对时刻（毫秒）
 * @param hostKey 宿主键（`once`/`dispose` 的作用域依据）
 * @param disp 消亡窗口状态
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

/**
 * loop 未给 ms（自管节奏）：逐帧活跃，ctx.next() 推进 iteration、stop() 终止。
 *
 * 没有固定迭代时长，`iterationProgress` 恒为 0（进度由回调自管）；
 * 迭代号与迭代起点按单元键存在引擎状态里，跨帧连续。
 *
 * @param deps 求值依赖
 * @param span 当前段窗口（`parentT` = t − span.start）
 * @param unit 当前单元（必须带 `loop`，且 `iterationMs` 省略）
 * @param f 帧序号（全局帧号，从 0 起）
 * @param t 全局时间线时刻（毫秒）
 * @param localT 段内相对时刻（毫秒）
 * @param chain 所属 spawn 链；主链单元传 `null`
 * @param deadKey 单元键（`sceneId/unitKey`），自管循环状态的登记键
 * @param hostKey 宿主键（`stop()`/`dispose` 用它杀全迭代）
 * @param disp 消亡窗口状态
 */
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
