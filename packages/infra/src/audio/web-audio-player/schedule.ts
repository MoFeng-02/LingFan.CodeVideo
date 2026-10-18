/** 预览端单声音排程：素材声与程序化音源各建一张节点图，并返回运行期句柄。 */
import type { AudioVoice, LiveVoice, Ms } from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import { seededRandom, synthAmpEnvelopePoints, synthSeed } from "../synth";
import { evaluateVoice } from "../voice-timeline";
import { applyGain, applyRate } from "./automation";
import type { PlayerEnv } from "./types";

/** 素材声节点图：source（含变速自动化）→ gain（包络）→ [pan] → 总线 */
export function scheduleVoice(
  env: PlayerEnv,
  voice: AudioVoice,
): LiveVoice | null {
  const pending = env.bufferOf(voice.clip.url);
  let src: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;

  pending
    .then((buffer) => {
      const tl = evaluateVoice(
        voice,
        buffer.duration * 1000,
        env.programDurationMs,
      );
      if (tl.endMs <= Math.max(tl.startMs, env.nowMs())) return;
      const start = env.ctxSecOf(tl.startMs);
      const end = env.ctxSecOf(tl.endMs);
      const node = env.ctx.createBufferSource();
      node.buffer = buffer;
      node.loop = voice.loop !== null;
      applyRate(
        env.ctx,
        env.ctxSecOf,
        node.playbackRate,
        voice,
        tl.startMs,
        buffer.duration * 1000,
      );
      const envelope = env.ctx.createGain();
      applyGain(env.ctxSecOf, envelope.gain, tl.gainPoints, end);
      node.connect(envelope);
      route(env, voice, envelope, tl.pan);
      node.start(
        Math.max(start, env.ctx.currentTime),
        Math.max(0, tl.sourceMsAt(tl.startMs) / 1000),
      );
      // 终点显式收声并释放：loop 源本身无限长，不 stop 会越过时间线尾一直响
      node.stop(end);
      env.sources.push(node);
      src = node;
      gain = envelope;
    })
    .catch(() => {
      // 预览加载失败不打断渲染（导出端由 AudioClock 自己报错）
    });

  const setRate: LiveVoice["setRate"] = (atMs, value, rampMs) => {
    if (!src) return;
    const t = at(env, atMs);
    const p = src.playbackRate;
    p.setValueAtTime(p.value, t);
    if (rampMs > 0) p.linearRampToValueAtTime(value, t + rampMs / 1000);
    else p.setValueAtTime(value, t);
  };
  return makeLiveHandle(
    env,
    () => gain,
    () => src,
    setRate,
  );
}

/**
 * 程序化音源排程：振荡器/噪声源 + ADSR 自动化 + 声音增益，
 * 与导出端共用同一组包络折点（时值由 spec.durationMs 决定）。
 * 包络与声音增益各自一个增益节点串联：两个线性斜坡相乘即导出端的逐样本乘积，
 * 合进同一个节点则只能按折点取积再线性插值，段内会与导出端偏离。
 * 声音速率在这里只决定时间线终点：振荡器按声明频率发声，不做重采样；
 * 运行期 setRate 折算成音分只改音高、不改时长——与导出端的磁带式重采样是两条路径。
 */
export function scheduleSynth(
  env: PlayerEnv,
  voice: AudioVoice,
): LiveVoice | null {
  const spec = voice.synth!;
  const tl = evaluateVoice(voice, spec.durationMs, env.programDurationMs);
  if (tl.endMs <= tl.startMs) return null;
  const start = Math.max(env.ctxSecOf(tl.startMs), env.ctx.currentTime);
  const end = env.ctxSecOf(tl.endMs);
  const ampGain = env.ctx.createGain();
  applyGain(env.ctxSecOf, ampGain.gain, synthAmpEnvelopePoints(spec), end);
  const gain = env.ctx.createGain();
  applyGain(env.ctxSecOf, gain.gain, tl.gainPoints, end);
  let src: AudioScheduledSourceNode;
  let rateParam: AudioParam | null = null;
  if (spec.wave === "noise") {
    const frames = Math.max(
      1,
      Math.round((spec.durationMs / 1000) * env.ctx.sampleRate),
    );
    const buffer = env.ctx.createBuffer(1, frames, env.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const rnd = seededRandom(synthSeed(spec));
    for (let i = 0; i < frames; i++) data[i] = rnd() * 2 - 1;
    const node = env.ctx.createBufferSource();
    node.buffer = buffer;
    src = node;
  } else {
    const osc = env.ctx.createOscillator();
    osc.type =
      spec.wave === "saw"
        ? "sawtooth"
        : spec.wave === "triangle"
          ? "triangle"
          : spec.wave === "square"
            ? "square"
            : "sine";
    osc.frequency.value = Math.max(0.01, spec.freq);
    osc.detune.value = spec.detune ?? 0;
    rateParam = osc.detune;
    src = osc;
  }
  src.connect(ampGain);
  ampGain.connect(gain);
  route(env, voice, gain, tl.pan);
  src.start(start);
  src.stop(end);
  env.sources.push(src);

  const setRate: LiveVoice["setRate"] = (atMs, value, rampMs) => {
    if (!rateParam) return;
    const t = at(env, atMs);
    const cents = 1200 * Math.log2(Math.max(1e-6, value));
    rateParam.setValueAtTime(rateParam.value, t);
    if (rampMs > 0) rateParam.linearRampToValueAtTime(cents, t + rampMs / 1000);
    else rateParam.setValueAtTime(cents, t);
  };
  return makeLiveHandle(
    env,
    () => gain,
    () => src,
    setRate,
  );
}

/** 出口接线：pan（非零才插节点）→ 目标总线（缺省 master，再缺省 destination） */
function route(
  env: PlayerEnv,
  voice: AudioVoice,
  tail: AudioNode,
  pan: number,
): void {
  let out: AudioNode = tail;
  if (Math.abs(pan) > 0) {
    const panner = env.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    tail.connect(panner);
    out = panner;
  }
  const targetBus =
    (voice.bus && env.buses.get(voice.bus)?.input) ||
    env.buses.get(MASTER_BUS)?.input ||
    env.ctx.destination;
  out.connect(targetBus);
}

/** 句柄的通用部分：stop 淡出、setGain 折线；setRate 由各排程路径提供 */
function makeLiveHandle(
  env: PlayerEnv,
  gainOf: () => GainNode | null,
  sourceOf: () => AudioScheduledSourceNode | null,
  setRate: LiveVoice["setRate"],
): LiveVoice {
  return {
    stop: (atMs, fadeMs) => {
      const gain = gainOf();
      const src = sourceOf();
      if (!gain || !src) return;
      const stopAt = env.ctxSecOf(atMs);
      const fadeFrom = Math.max(env.ctx.currentTime, stopAt - fadeMs / 1000);
      gain.gain.setValueAtTime(gain.gain.value, fadeFrom);
      gain.gain.linearRampToValueAtTime(0, stopAt);
      try {
        src.stop(stopAt);
      } catch {
        // 已停止
      }
    },
    setGain: (atMs, value, rampMs) => {
      const gain = gainOf();
      if (!gain) return;
      const t = at(env, atMs);
      gain.gain.setValueAtTime(gain.gain.value, t);
      if (rampMs > 0)
        gain.gain.linearRampToValueAtTime(value, t + rampMs / 1000);
      else gain.gain.setValueAtTime(value, t);
    },
    setRate,
  };
}

/** 时间线毫秒 → 上下文秒，且不早于当前时刻 */
function at(env: PlayerEnv, globalMs: Ms): number {
  return Math.max(env.ctxSecOf(globalMs), env.ctx.currentTime);
}
