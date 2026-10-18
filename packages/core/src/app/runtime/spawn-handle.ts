import type {
  Handle,
  KillOptions,
  Ms,
  Scheduler,
  SpawnOptions,
} from "@lingfan-video/contracts";
import type { SceneInternal } from "../../domain/simulation/types";
import type {
  ChainSpan,
  EvalDeps,
  SpawnChain,
  TimelineState,
} from "./engine-types";
import { spawnChain } from "./runtime-spawn";

/** 运行期 spawn（StepContext/LoopContext.spawn）：同 key 活跃 → 续接返回既有句柄 */
export function dynamicSpawn(
  deps: EvalDeps,
  scene: SceneInternal<unknown>,
  options: SpawnOptions,
  t: Ms,
  _parent: SpawnChain | null,
): Handle {
  const explicit = options.forever ? Infinity : options.duration;
  // duration 原样传：undefined = 链长按内容实况回填（异步 setup 的链在帧边界物化）
  const chain = spawnChain(
    deps.state,
    options.key,
    scene,
    t,
    explicit,
    options.fps,
  );
  // 链长语义：显式 duration 覆盖；缺省 = 链内容之和（物化完成后回填）
  if (explicit === Infinity)
    chain.end = Infinity; // 运行期 forever：总尾在 run 收尾后仍未知，续接链由 kill 控制
  else if (explicit !== undefined) chain.end = t + explicit;
  return makeHandle(chain, deps.state);
}

/** 链级消杀：fadeOut > 0 进入消亡窗口（窗口内继续求值），否则立即死 */
export function disposeChain(
  chain: SpawnChain,
  nowMs: Ms,
  options?: KillOptions,
): void {
  const fade = options?.fadeOut ?? 0;
  if (fade > 0) {
    chain.dyingFrom = nowMs;
    chain.dyingUntil = nowMs + fade;
  } else {
    chain.killed = true;
  }
}

/** 单元级消杀：key 用 `${sceneId}/${unitKey|loopBase}`；fadeOut > 0 走消亡窗口 */
export function disposeUnit(
  state: TimelineState,
  nowMs: Ms,
  key: string,
  options?: KillOptions,
): void {
  const fade = options?.fadeOut ?? 0;
  if (fade > 0) state.dyingUnits.set(key, { from: nowMs, until: nowMs + fade });
  else state.deadUnits.add(key);
}

/** 按 id 找单元（step/loop 的 options.id）：返回宿主键（loop 用 loopBase 杀全迭代） */
function unitKeyById(state: TimelineState, id: string): string | undefined {
  const hit = (span: ChainSpan): string | undefined => {
    for (const u of span.seg.units) {
      if (u.disposeId === id) return `${span.scene.id}/${u.loopBase ?? u.key}`;
    }
    return undefined;
  };
  for (const chain of state.spawnChains) {
    for (const span of chain.spans) {
      const k = hit(span);
      if (k) return k;
    }
  }
  for (const span of state.spans) {
    const k = hit(span);
    if (k) return k;
  }
  return undefined;
}

/** Handle 工厂：kill/dispose 双杀同义；alive 计入消亡窗口 */
export function makeHandle(chain: SpawnChain, state: TimelineState): Handle {
  return {
    kill: (options?: KillOptions) => disposeChain(chain, state.nowMs, options),
    dispose: (options?: KillOptions) =>
      disposeChain(chain, state.nowMs, options),
    get alive() {
      const exited =
        chain.dyingUntil !== undefined && state.nowMs >= chain.dyingUntil;
      return !chain.killed && !exited && state.nowMs < chain.end;
    },
    get localTime() {
      return state.nowMs - chain.start;
    },
    get duration() {
      return chain.end === Infinity ? Infinity : chain.end - chain.start;
    },
  };
}

/** Scheduler 门面：key/句柄/id 三路消杀（同 key 续接的官方通道） */
export function schedulerFacade(state: TimelineState, t: Ms): Scheduler {
  return {
    kill: (handleOrKey, options?: KillOptions) => {
      if (typeof handleOrKey !== "string") {
        handleOrKey.kill(options);
        return;
      }
      const chain = state.spawnChains.find((c) => c.key === handleOrKey);
      if (chain) {
        disposeChain(chain, state.nowMs, options);
        return;
      }
      const unitKey = unitKeyById(state, handleOrKey);
      if (unitKey) disposeUnit(state, state.nowMs, unitKey, options);
    },
    killAll: (options?: KillOptions) => {
      for (const c of state.spawnChains) disposeChain(c, state.nowMs, options);
    },
    get alive() {
      return state.spawnChains.filter(
        (c) =>
          !c.killed &&
          (c.dyingUntil === undefined || t < c.dyingUntil) &&
          t < c.end,
      ).length;
    },
  };
}
