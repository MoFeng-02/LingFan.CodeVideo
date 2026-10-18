/**
 * 运行期音频：ctx.audio 的实现（发射 + 句柄）。
 * 语义：声音是时间线上的一等对象——发射后不因幕/段/链边界消失，
 * 只在三处终止：源自然播完、句柄 stop()、总时间线尾。
 * 记录形态与登记期完全一致（同一 AudioVoice 契约），导出端据此离线渲染，
 * 预览端把同一记录交给实时输出（AudioOutput）。
 */
import type {
  AudioClip,
  AudioHandle,
  AudioOp,
  AudioOptions,
  AudioVoice,
  GainLike,
  Ms,
  SynthSpec,
} from "@lingfan-video/contracts";
import { makeVoice } from "../../domain/audio";
import { toLinearGain } from "../../domain/audio/gain-units";
import { makeRenderError } from "./error";
import type { EvalDeps, TimelineState } from "./engine-types";

/** 运行期可变声音记录（contracts 侧只读；引擎内部追加 ops） */
export interface MutableVoice {
  id: string;
  clip: AudioClip;
  startMs: Ms;
  gain: AudioVoice["gain"];
  pan: AudioVoice["pan"];
  loop: AudioVoice["loop"];
  rate: AudioVoice["rate"];
  ops: AudioOp[];
  /** 送往哪条总线（缺省 master） */
  bus?: AudioVoice["bus"];
  /** 程序化音源 */
  synth?: SynthSpec;
}

/** 新建声音记录并登记（id 由引擎序号分配，保证确定性） */
export function pushVoice(
  state: TimelineState,
  clip: AudioClip,
  startMs: Ms,
  options?: AudioOptions,
  synth?: SynthSpec,
): MutableVoice {
  const voice = makeVoice(
    `voice#${state.voiceSeq++}`,
    clip,
    startMs,
    options,
  ) as MutableVoice;
  voice.ops = [];
  if (synth) voice.synth = synth;
  state.audioVoices.push(voice);
  return voice;
}

/**
 * ctx.audio 实现：登记声音、交给实时输出（若装配）、返回句柄。
 * 句柄操作以「当前求值时刻」为生效时刻；回调之外调用属于没有时间轴依据的操作，
 * 直接报 spec_violation（不让声音的操作时刻变成未定义）。
 */
export function emitAudio(
  deps: EvalDeps,
  clip: AudioClip,
  options: AudioOptions | undefined,
  atMs: Ms,
  synth?: SynthSpec,
): AudioHandle {
  const { state } = deps;
  // 运行期 `at` = 相对发射时刻的延迟（登记期语义 = 相对登记位置，见 compile）
  const delay = Math.max(0, options?.at ?? 0);
  const startMs = Math.max(0, atMs + delay);
  const voice = pushVoice(state, clip, startMs, options, synth);
  const live = state.opts.audioOut?.start(voice);
  let stopped = false;

  const requireCallback = (what: string): void => {
    if (!state.inCallback)
      throw makeRenderError(
        "spec_violation",
        "audio",
        state.nowMs,
        `${what}：句柄操作只能在 step/loop 回调内调用（声音的操作时刻取自当前求值时间）`,
      );
  };

  return {
    id: voice.id,
    startedAtMs: startMs,
    get alive(): boolean {
      return !stopped && state.nowMs < state.timelineEnd;
    },
    stop(fadeOutMs?: Ms): void {
      requireCallback("audio.stop");
      if (stopped) return;
      stopped = true;
      const fadeMs = Math.max(0, fadeOutMs ?? 0);
      voice.ops.push({ kind: "stop", atMs: state.nowMs, fadeMs });
      live?.stop(state.nowMs, fadeMs);
    },
    setGain(value: GainLike, rampMs?: Ms): void {
      requireCallback("audio.setGain");
      // 分贝在这里折算成线性幅度：时间线上的操作记录只存线性值（导出/预览同一口径）
      let linear: number;
      try {
        linear = toLinearGain(value, "setGain");
      } catch (err) {
        throw makeRenderError(
          "spec_violation",
          "audio",
          state.nowMs,
          (err as Error).message.replace(/^spec_violation: /, ""),
        );
      }
      const ramp = Math.max(0, rampMs ?? 0);
      voice.ops.push({
        kind: "gain",
        atMs: state.nowMs,
        value: linear,
        rampMs: ramp,
      });
      live?.setGain(state.nowMs, linear, ramp);
    },
    setRate(value: number, rampMs?: Ms): void {
      requireCallback("audio.setRate");
      if (!Number.isFinite(value) || value <= 0)
        throw makeRenderError(
          "spec_violation",
          "audio",
          state.nowMs,
          `setRate(${value}) 须为 > 0 的有限数（禁倒放、静止）`,
        );
      const ramp = Math.max(0, rampMs ?? 0);
      voice.ops.push({ kind: "rate", atMs: state.nowMs, value, rampMs: ramp });
      live?.setRate(state.nowMs, value, ramp);
    },
  };
}
