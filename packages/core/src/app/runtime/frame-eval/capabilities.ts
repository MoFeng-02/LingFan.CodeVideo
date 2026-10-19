/**
 * 回调能力集的装配：音频、音频图、自消杀、事件去重。
 *
 * 这些能力按帧注入到 step/loop/wait 上下文里（「能力即上下文」），
 * 本模块只负责把引擎状态包装成契约形状，不持有跨帧状态。
 */
import { SYNTH_CLIP } from "../../../domain/audio/synth-clip";
import { synthVoiceOptions } from "../../../domain/audio/synth-voice";
import type {
  AudioEnv,
  AudioGraphEnv,
  Ms,
  OnceEnv,
  OnceFn,
  OnceScope,
} from "@lingfan-video/contracts";
import {
  ensureBusParams,
  ensureBusSpec,
  makeBusHandle,
  registerDuck,
  registerSend,
} from "../audio-graph";
import { emitAudio } from "../audio-runtime";
import { makeRenderError } from "../error";
import type { EvalDeps, SpawnChain } from "../engine-types";
import { disposeUnit } from "../spawn-handle";

/**
 * 运行期音频图能力（bus 句柄 / send / duck；与 audio 同一注入面）。
 *
 * `bus(id)` 是唯一会立刻返回句柄的入口：给了 spec 就补登记拓扑（仅补不存在的），
 * 无论是否给 spec 都保证该总线的参数面存在，以便回调马上改参数。
 *
 * @param deps 求值依赖（读写引擎状态）
 * @returns AudioGraphEnv：`bus` / `send` / `duck`
 */
export function graphOf(deps: EvalDeps): AudioGraphEnv {
  return {
    bus: (id, spec) => {
      if (spec) ensureBusSpec(deps.state, id, spec);
      ensureBusParams(deps.state, id);
      return makeBusHandle(deps, id);
    },
    send: (spec) => registerSend(deps.state, spec),
    duck: (rule) => registerDuck(deps.state, rule),
  };
}

/**
 * 运行期音频能力（能力即上下文：与 spawn/scheduler 同一注入面）。
 *
 * @param deps 求值依赖（声音记录写进引擎状态）
 * @param t 发射时刻（时间线毫秒）；`options.at` 在此之上叠加为延迟
 * @returns AudioEnv 的两项能力：`audio(clip, options?)` 与 `synth(spec)`
 */
export function audioOf(
  deps: EvalDeps,
  t: Ms,
): Pick<AudioEnv, "audio" | "synth"> {
  return {
    audio: (clip, options) => emitAudio(deps, clip, options, t),
    // 程序化音源：同一套声音记录（synth 字段给混音层一个确定性生成器）
    synth: (spec) =>
      emitAudio(deps, SYNTH_CLIP, synthVoiceOptions(spec), t, spec),
  };
}

/**
 * 自消杀糖：把「本单元」推进消亡（fadeOut 给消失过程）。
 *
 * @param deps 求值依赖（消杀状态写进引擎状态）
 * @param t 调用时刻（时间线毫秒），作为消亡窗口起点
 * @param hostKey 宿主键（`sceneId/unitKey`；loop 用 loopBase，一次杀全迭代）
 * @returns `dispose(options?)`：`fadeOut > 0` 进入窗口，否则立即硬死
 */
export function selfDisposeOf(deps: EvalDeps, t: Ms, hostKey: string) {
  return (options?: { fadeOut?: Ms }): void =>
    disposeUnit(deps.state, t, hostKey, options);
}

/** 确定性去重键（不含随机/墙钟：同程序必同键） */
function onceKeyOf(
  scope: OnceScope,
  sceneId: string,
  hostKey: string,
  chain: SpawnChain | null,
  iteration: number | undefined,
): string {
  switch (scope) {
    case "scene":
      return `scene:${sceneId}`;
    case "spawn":
      return `spawn:${sceneId}/${chain?.key ?? "main"}`;
    case "iteration":
      return `iter:${sceneId}/${hostKey}#${iteration ?? 0}`;
    case "unit":
      return `unit:${sceneId}/${hostKey}`;
  }
}

/**
 * 事件去重：同一作用域首次触发才执行；能力集只给发声与自消杀。
 *
 * 去重键由作用域和单元实例推出，不含随机数与墙钟——同程序必得同键，
 * 因此「第一次到这一步」是确定性的。
 *
 * @param deps 求值依赖（去重键合集挂在 `state.onceKeys`）
 * @param t 当前求值时刻（毫秒），作为回调里发声的时刻
 * @param sceneId 所属场景 id（作用域键的一部分）
 * @param hostKey 宿主键（`sceneId/unitKey`，loop 为宿主锚点）
 * @param chain 所属 spawn 链；主链传 `null`（`spawn` 作用域会区分链）
 * @param iteration 当前迭代号（仅 `iteration` 作用域使用；无迭代时为 `undefined`，按 0 计）
 * @returns 契约的 `once`：`once(fn)` 等价于 `once("unit", fn)`
 * @throws RenderError（kind = step_throw）回调缺省时
 */
export function onceOf(
  deps: EvalDeps,
  t: Ms,
  sceneId: string,
  hostKey: string,
  chain: SpawnChain | null,
  iteration: number | undefined,
): OnceEnv["once"] {
  const dispose = selfDisposeOf(deps, t, hostKey);
  const once = (a: OnceScope | OnceFn, b?: OnceFn): void => {
    const scope: OnceScope = typeof a === "function" ? "unit" : a;
    const fn = typeof a === "function" ? a : b;
    if (!fn) throw makeRenderError("step_throw", sceneId, t, "once 缺少回调");
    const key = onceKeyOf(scope, sceneId, hostKey, chain, iteration);
    if (deps.state.onceKeys.has(key)) return;
    deps.state.onceKeys.add(key);
    fn({ audio: audioOf(deps, t).audio, dispose });
  };
  return once as OnceEnv["once"];
}
