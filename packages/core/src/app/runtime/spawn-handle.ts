import type {
  Handle,
  Ms,
  Scheduler,
  SpawnOptions,
} from "@lingfan-video/contracts";
import type { SceneInternal } from "../../domain/simulation/types";
import type { EvalDeps, SpawnChain, TimelineState } from "./engine-types";
import { buildChain } from "./timeline-build";

/** 运行期 spawn（StepContext/LoopContext.spawn）：同 key 活跃 → 续接返回既有句柄 */
export function dynamicSpawn(
  deps: EvalDeps,
  scene: SceneInternal<unknown>,
  options: SpawnOptions,
  t: Ms,
  _parent: SpawnChain | null,
): Handle {
  const explicit = options.forever ? Infinity : options.duration;
  const chain =
    buildChain(deps.state, options.key, scene, t, explicit ?? 0, options.fps) ??
    deps.state.spawnChains.find((c) => c.key === options.key && !c.killed)!;
  // 链长语义：显式 duration 覆盖；缺省 = 链内容之和（buildChain 按 transition 短路实况回填）
  if (explicit === Infinity)
    chain.end = Infinity; // 运行期 forever：总尾在 run 收尾后仍未知，续接链由 kill 控制
  else if (explicit !== undefined) chain.end = t + explicit;
  return makeHandle(chain, t);
}

/** Handle 工厂：kill/dispose 双杀同义，alive/localTime/duration 只读 */
export function makeHandle(chain: SpawnChain, t: Ms): Handle {
  let killed = false;
  return {
    kill: () => {
      killed = true;
      chain.killed = true;
    },
    dispose: () => {
      killed = true;
      chain.killed = true;
    },
    get alive() {
      return !killed && !chain.killed && t < chain.end;
    },
    get localTime() {
      return t - chain.start;
    },
    get duration() {
      return chain.end === Infinity ? Infinity : chain.end - chain.start;
    },
  };
}

/** Scheduler 门面：key 级去重杀链（同 key 续接的官方通道） */
export function schedulerFacade(state: TimelineState, t: Ms): Scheduler {
  const chains = state.spawnChains;
  return {
    kill: (handleOrKey) => {
      if (typeof handleOrKey === "string") {
        const c = chains.find((x) => x.key === handleOrKey);
        if (c) c.killed = true;
      } else {
        handleOrKey.kill();
      }
    },
    killAll: () => {
      for (const c of chains) c.killed = true;
    },
    get alive() {
      return chains.filter((c) => !c.killed && t < c.end).length;
    },
  };
}
