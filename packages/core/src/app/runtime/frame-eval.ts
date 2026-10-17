import type {
  AudioClip,
  AudioHandle,
  AudioOptions,
  FrameIndex,
  LoopContext,
  Ms,
  RenderError,
  StepContext,
} from "@lingfan-video/contracts";
import type {
  CompiledUnit,
  SceneInternal,
} from "../../domain/simulation/types";
import { emitAudio } from "./audio-runtime";
import { makeRenderError } from "./error";
import type { ChainSpan, EvalDeps, SpawnChain } from "./engine-types";
import { findSpan, findSpanLooping } from "./timeline-build";
import { disposeUnit, dynamicSpawn, schedulerFacade } from "./spawn-handle";

function wrapThrow(e: unknown, sceneId: string, t: Ms, what: string): never {
  if ((e as RenderError).kind) throw e;
  throw makeRenderError(
    "step_throw",
    sceneId,
    t,
    `${what}回调抛错：${(e as Error).message}`,
  );
}

/** 消亡窗口状态（disposing + 进度；窗口外恒 false/0） */
interface DisposalInfo {
  disposing: boolean;
  progress: number;
}

const NONE: DisposalInfo = { disposing: false, progress: 0 };

function progressIn(from: Ms, until: Ms, t: Ms): number {
  if (until <= from) return 1;
  return Math.min(1, Math.max(0, (t - from) / (until - from)));
}

/** 链级消亡：整条链共享一个窗口（窗口内所有单元都看到 disposing） */
function chainDisposal(chain: SpawnChain | null, t: Ms): DisposalInfo {
  if (!chain || chain.dyingFrom === undefined || chain.dyingUntil === undefined)
    return NONE;
  if (t < chain.dyingFrom || t >= chain.dyingUntil) return NONE;
  return {
    disposing: true,
    progress: progressIn(chain.dyingFrom, chain.dyingUntil, t),
  };
}

/** 单元级消亡：按宿主键/单元键查窗口 */
function unitDisposal(
  deps: EvalDeps,
  keys: string[],
  t: Ms,
): DisposalInfo | undefined {
  for (const k of keys) {
    const d = deps.state.dyingUnits.get(k);
    if (d && t >= d.from && t < d.until)
      return { disposing: true, progress: progressIn(d.from, d.until, t) };
  }
  return undefined;
}

/** 逐帧求值：绘制顺序 spawn 链（背景）在前、登记链在后 */
export function evaluateFrame(deps: EvalDeps, f: FrameIndex, t: Ms): void {
  const { state } = deps;
  state.nowMs = t; // 句柄操作/声音 alive 的时间轴依据 = 当前求值时刻
  const ordered: Array<{ chain: SpawnChain | null; span: ChainSpan }> = [];
  for (const c of state.spawnChains) {
    if (c.killed || t < c.start || t >= c.end) continue;
    // 消亡窗口到期 = 真正出池
    if (c.dyingUntil !== undefined && t >= c.dyingUntil) continue;
    // forever 链内容播完后循环重放（回卷 span）；一次性链照常查
    const span = findSpanLooping(c, t);
    if (span) ordered.push({ chain: c, span });
  }
  const main = findSpan(state.spans, t);
  if (main) ordered.push({ chain: null, span: main });

  for (const { chain, span } of ordered) {
    const localT = t - span.start;
    const chainDisp = chainDisposal(chain, t);
    for (const unit of span.seg.units) {
      const deadKey = `${span.scene.id}/${unit.key}`;
      const hostKey = unit.loopBase
        ? `${span.scene.id}/${unit.loopBase}`
        : deadKey;
      if (state.deadUnits.has(deadKey)) continue;
      // loop stop() 按宿主杀全迭代（loopBase 锚点）
      if (unit.loopBase && state.deadUnits.has(hostKey)) continue;
      // 消亡窗口到期 → 转硬死（此后不再求值）
      for (const k of new Set([deadKey, hostKey])) {
        const d = state.dyingUnits.get(k);
        if (d && t >= d.until) state.deadUnits.add(k);
      }
      if (state.deadUnits.has(deadKey)) continue;
      if (unit.loopBase && state.deadUnits.has(hostKey)) continue;
      if (localT < unit.windowStart || localT >= unit.windowEnd) {
        if (unit.hold && localT >= unit.windowEnd)
          deps.aggregator.touchHold(`${span.scene.id}/${unit.key}`); // hold 冻结糖
        continue;
      }
      const disp =
        unitDisposal(deps, [...new Set([deadKey, hostKey])], t) ?? chainDisp;
      if (unit.loop && unit.loop.iterationMs === undefined)
        evalForm3(
          deps,
          span,
          unit,
          f,
          t,
          localT,
          chain,
          deadKey,
          hostKey,
          disp,
        );
      else if (unit.loop)
        evalLoopIter(
          deps,
          span,
          unit,
          f,
          t,
          localT - unit.windowStart,
          chain,
          hostKey,
          disp,
        );
      else
        evalStep(
          deps,
          span,
          unit,
          f,
          t,
          localT - unit.windowStart,
          chain,
          hostKey,
          disp,
        );
    }
  }
}

/**
 * 执行回调（同时也是音频句柄操作的合法窗口）：
 * 返回值是 FrameState 则发布（经 key 化聚合），否则无状态发布。
 */
function invoke(
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

/** 运行期音频能力（能力即上下文：与 spawn/scheduler 同一注入面） */
function audioOf(
  deps: EvalDeps,
  t: Ms,
): (clip: AudioClip, options?: AudioOptions) => AudioHandle {
  return (clip, options) => emitAudio(deps, clip, options, t);
}

/** 自消杀糖：把「本单元」推进消亡（fadeOut 给消失过程） */
function selfDisposeOf(deps: EvalDeps, t: Ms, hostKey: string) {
  return (options?: { fadeOut?: Ms }): void =>
    disposeUnit(deps.state, t, hostKey, options);
}

/** step 单元：StepContext + FrameState 发布 */
function evalStep(
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
    fps: uf,
    deltaTime: 1000 / uf,
    localT: localIn,
    duration,
    progress: duration > 0 ? localIn / duration : 0,
    spawn: (scene, options) =>
      dynamicSpawn(deps, scene as SceneInternal<unknown>, options, t, chain),
    scheduler: schedulerFacade(deps.state, t),
    audio: audioOf(deps, t),
    disposing: disp.disposing,
    disposeProgress: disp.progress,
    dispose: selfDisposeOf(deps, t, hostKey),
  };
  invoke(deps, span, unit, ctx, t);
}

/** loop 预展开迭代单元：LoopContext（iteration/iterationT/iterationProgress） */
function evalLoopIter(
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
    audio: audioOf(deps, t),
    disposing: disp.disposing,
    disposeProgress: disp.progress,
    dispose: selfDisposeOf(deps, t, hostKey),
  };
  invoke(deps, span, unit, ctx, t);
}

/** loop 无固定迭代窗（自管节奏）：逐帧活跃，ctx.next() 推进 iteration、stop() 终止 */
function evalForm3(
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
  const cur = deps.state.form3.get(deadKey) ?? {
    iteration: 0,
    iterStart: localT,
  };
  if (!deps.state.form3.has(deadKey)) deps.state.form3.set(deadKey, cur);
  const uf = unit.fps;
  const ctx: LoopContext = {
    canvas,
    width,
    height,
    f: (n: number) => (n * 1000) / uf,
    parentT: t - span.start,
    frameIndex: f,
    fps: uf,
    deltaTime: 1000 / uf,
    iteration: cur.iteration,
    iterationT: localT - cur.iterStart,
    iterationProgress: 0, // form-3 无迭代时长，进度自管
    next: () => {
      cur.iteration += 1;
      cur.iterStart = localT;
    },
    stop: () => deps.state.deadUnits.add(hostKey),
    spawn: (scene, options) =>
      dynamicSpawn(deps, scene as SceneInternal<unknown>, options, t, chain),
    scheduler: schedulerFacade(deps.state, t),
    audio: audioOf(deps, t),
    disposing: disp.disposing,
    disposeProgress: disp.progress,
    dispose: selfDisposeOf(deps, t, hostKey),
  };
  invoke(deps, span, unit, ctx, t);
}
