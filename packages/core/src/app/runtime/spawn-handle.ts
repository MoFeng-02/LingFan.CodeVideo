/**
 * 句柄面：把引擎内部的链/单元状态包装成契约的 Handle、Scheduler 与消杀操作。
 *
 * 所有操作以「当前求值时刻」（`state.nowMs`）为生效时刻——回调之外没有时间轴依据，
 * 因此句柄只应在 step/loop/wait 回调内使用。带 fadeOut 的消杀不是立即消失：
 * 目标进入消亡窗口继续求值，窗口到期才真正出池。
 */
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

/**
 * 运行期 spawn（StepContext/LoopContext.spawn）：同 key 活跃 → 续接返回既有句柄。
 *
 * 链长语义：显式 `duration` 覆盖；`forever` 的终点未知（由 kill 控制）；
 * 两者都不给时链长按内容实况回填（异步 setup 的链在帧边界物化后才定）。
 *
 * @param deps 求值依赖（状态里登记链）
 * @param scene 要推演的场景（作为链头）
 * @param options 链选项：key 必填（去重键），`at` 不参与运行期 spawn（起点就是当前时刻）
 * @param t 当前求值时刻（时间线毫秒），即链起点
 * @param _parent 发起 spawn 的链（保留位，当前不参与链登记）
 * @returns 链句柄：`kill`/`dispose` 消杀，`alive`/`localTime`/`duration` 反映当前状态
 */
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

/**
 * 链级消杀：fadeOut > 0 进入消亡窗口（窗口内继续求值），否则立即死。
 *
 * @param chain 目标链
 * @param nowMs 生效时刻（时间线毫秒）
 * @param options 只取 `fadeOut`（毫秒，> 0 时开窗；缺省 0 = 立即硬杀）
 */
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

/**
 * 单元级消杀：key 用 `${sceneId}/${unitKey|loopBase}`；fadeOut > 0 走消亡窗口。
 *
 * @param state 引擎状态（写入硬死集合或消亡窗口表）
 * @param nowMs 生效时刻（时间线毫秒）
 * @param key 宿主键：单元键，或 loop 的宿主锚点（杀全迭代）
 * @param options 只取 `fadeOut`（毫秒，> 0 时开窗；缺省 0 = 立即硬杀）
 */
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

/**
 * Handle 工厂：kill/dispose 双杀同义；alive 计入消亡窗口。
 *
 * 句柄是链状态的实时视图（getter 读当前求值时刻），不是快照：
 * 同一句柄在后续帧里看到的是链当时的 `alive` / `localTime`。
 *
 * @param chain 目标链
 * @param state 引擎状态（取当前求值时刻）
 * @returns 契约 Handle
 */
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

/**
 * Scheduler 门面：key/句柄/id 三路消杀（同 key 续接的官方通道）。
 *
 * `kill` 的参数按类型分派：句柄 → 直接杀链；字符串先当链 key，
 * 找不到再当单元 id（step/loop 的 `options.id`）。`alive` 是当前时刻活跃链数。
 *
 * @param state 引擎状态（链表、单元键反查）
 * @param t 当前求值时刻（时间线毫秒），用于 `alive` 计数
 * @returns 契约 Scheduler
 */
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
