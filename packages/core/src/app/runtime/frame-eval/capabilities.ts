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

/** 运行期音频图能力（bus 句柄 / send / duck；与 audio 同一注入面） */
export function graphOf(deps: EvalDeps, t: Ms): AudioGraphEnv {
  void t;
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

/** 运行期音频能力（能力即上下文：与 spawn/scheduler 同一注入面） */
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

/** 自消杀糖：把「本单元」推进消亡（fadeOut 给消失过程） */
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

/** 事件去重：同一作用域首次触发才执行；能力集只给发声与自消杀 */
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
