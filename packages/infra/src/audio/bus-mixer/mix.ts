/** 总线图混音流程：铺轨 → 拓扑序处理（效果/参数/侧链/发送）→ 汇入父总线。 */
import type { BusId, BusSpec } from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import { panGain } from "./dsp";
import { computeDuckGain } from "./duck";
import {
  compressorInPlace,
  delayInPlace,
  filterInPlace,
  reverbInPlace,
} from "./effects";
import {
  anySolo,
  makeAutomation,
  parentOfOf,
  topoOrder,
  type BusParams,
} from "./graph";
import type { BusMixInput } from "./types";

export function mixBusGraph(input: BusMixInput): Float32Array {
  const { sampleRate: sr, channels: ch, frames, graph } = input;
  const buses = new Map<BusId, BusSpec>();
  buses.set(MASTER_BUS, { id: MASTER_BUS });
  for (const b of graph.buses) buses.set(b.id, b);
  const order = topoOrder(buses, graph.sends, graph.ducks);

  const input_ = new Map<BusId, Float32Array>();
  for (const id of buses.keys()) input_.set(id, new Float32Array(frames * ch));
  for (const voice of input.voices) {
    const targetId = voice.bus && buses.has(voice.bus) ? voice.bus : MASTER_BUS;
    const target = input_.get(targetId)!;
    input.layoutVoice(voice, target, frames, input.durationMs);
  }

  const automation = new Map<BusId, (ms: number) => BusParams>();
  for (const a of graph.automation) automation.set(a.bus, makeAutomation(a));
  const staticParams = (id: BusId): BusParams => {
    const spec = buses.get(id);
    return {
      gain: spec?.gain ?? 1,
      pan: spec?.pan ?? 0,
      mute: spec?.mute ?? false,
      solo: spec?.solo ?? false,
    };
  };
  // 独奏：任一条非 master 总线在任一时刻 solo → 未 solo 的总线静音
  const soloActive = anySolo(graph);

  const outputs = new Map<BusId, Float32Array>();
  const duckGains = new Map<string, Float32Array>();
  for (const id of order) {
    const spec = buses.get(id);
    if (!spec) continue;
    let sig = input_.get(id)!;
    // 效果（就地；顺序 = 声明顺序）
    for (const eff of spec.effects ?? []) {
      if (eff.kind === "filter") filterInPlace(sig, eff, sr, ch);
      else if (eff.kind === "compressor") compressorInPlace(sig, eff, sr, ch);
      else if (eff.kind === "delay") delayInPlace(sig, eff, sr, ch);
      else reverbInPlace(sig, eff, sr, ch);
    }
    const out = new Float32Array(frames * ch);
    const auto = automation.get(id);
    const base = staticParams(id);
    const pan = auto ? (ms: number) => auto(ms).pan : () => base.pan;
    const gainOf = auto ? (ms: number) => auto(ms).gain : () => base.gain;
    const muteOf = auto ? (ms: number) => auto(ms).mute : () => base.mute;
    const soloOf = auto ? (ms: number) => auto(ms).solo : () => base.solo;
    for (let fr = 0; fr < frames; fr++) {
      const ms = (fr * 1000) / sr;
      const muted =
        muteOf(ms) || (soloActive && !soloOf(ms) && id !== MASTER_BUS);
      if (muted) continue;
      const g = gainOf(ms);
      if (g <= 0) continue;
      const pl = panGain(pan(ms), 0, ch);
      const pr = panGain(pan(ms), 1, ch);
      for (let c = 0; c < ch; c++) {
        out[fr * ch + c] = sig[fr * ch + c]! * g * (c === 0 ? pl : pr);
      }
    }
    // 侧链压制：来源总线必须先算出输出（拓扑序保证）
    for (const rule of graph.ducks.filter((d) => d.to === id)) {
      const from = outputs.get(rule.from);
      if (!from) continue; // 来源不可用（可能被静音整个跳过）→ 不压制
      const key = `${rule.from}->${rule.to}`;
      let reduction = duckGains.get(key);
      if (!reduction) {
        reduction = computeDuckGain(from, rule, sr, ch, frames);
        duckGains.set(key, reduction);
      }
      for (let i = 0; i < out.length; i++)
        out[i]! *= reduction[Math.floor(i / ch)]!;
    }
    // 发送（post-fader；pre 取效果前信号）
    for (const send of graph.sends.filter((s) => s.from === id)) {
      const target = input_.get(send.to);
      if (!target) continue;
      const src = send.pre ? input_.get(id)! : out;
      const amount = Math.max(0, send.amount);
      for (let i = 0; i < src.length; i++) target[i]! += src[i]! * amount;
    }
    outputs.set(id, out);
    // 汇入父总线（拓扑序保证父总线尚未处理）
    const parentId = parentOfOf(buses, id);
    const parentInput = parentId ? input_.get(parentId) : undefined;
    if (parentInput) {
      for (let i = 0; i < out.length; i++) parentInput[i]! += out[i]!;
    }
  }
  return outputs.get(MASTER_BUS) ?? new Float32Array(frames * ch);
}
