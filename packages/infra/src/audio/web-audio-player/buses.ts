/** 预览端总线节点图：按 program.graph 建节点与连线，并应用总线参数。 */
import type {
  AudioGraph,
  BusId,
  BusSpec,
  BusUpdate,
} from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import { seededRandom } from "../synth";
import type { BusNode, PlayerEnv } from "./types";

/** 建图结果：节点表与各总线当前参数 */
export interface BusGraph {
  buses: Map<BusId, BusNode>;
  params: Map<BusId, BusUpdate>;
}

/** 建总线节点图（拓扑固定；缺省 = 声音直连 destination） */
export function buildBusGraph(
  ctx: AudioContext,
  graph: AudioGraph | undefined,
): BusGraph {
  const buses = new Map<BusId, BusNode>();
  const params = new Map<BusId, BusUpdate>();
  const specs = new Map<BusId, BusSpec & { parent?: BusId }>();
  specs.set(MASTER_BUS, { id: MASTER_BUS });
  for (const b of graph?.buses ?? []) specs.set(b.id, b);
  for (const [id, spec] of specs) {
    const input = ctx.createGain();
    const gain = ctx.createGain();
    const panner = id === MASTER_BUS ? null : ctx.createStereoPanner();
    let tail: AudioNode = input;
    for (const eff of spec.effects ?? []) {
      if (eff.kind === "filter") {
        const filter = ctx.createBiquadFilter();
        filter.type =
          eff.type === "lowpass"
            ? "lowpass"
            : eff.type === "highpass"
              ? "highpass"
              : "bandpass";
        filter.frequency.value = eff.frequency;
        filter.Q.value = eff.q ?? Math.SQRT1_2;
        tail.connect(filter);
        tail = filter;
      } else if (eff.kind === "compressor") {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = eff.thresholdDb;
        comp.ratio.value = eff.ratio;
        comp.attack.value = eff.attackMs / 1000;
        comp.release.value = eff.releaseMs / 1000;
        comp.knee.value = eff.kneeDb ?? 6;
        tail.connect(comp);
        tail = comp;
      } else if (eff.kind === "delay") {
        const delay = ctx.createDelay(5);
        delay.delayTime.value = Math.max(0.001, eff.delayMs / 1000);
        const fb = ctx.createGain();
        fb.gain.value = Math.max(0, Math.min(0.95, eff.feedback ?? 0.3));
        const wet = ctx.createGain();
        wet.gain.value = Math.max(0, Math.min(1, eff.mix ?? 0.5));
        const dry = ctx.createGain();
        dry.gain.value = 1 - wet.gain.value;
        const merge = ctx.createGain();
        tail.connect(dry);
        dry.connect(merge);
        tail.connect(delay);
        delay.connect(wet);
        wet.connect(merge);
        delay.connect(fb);
        fb.connect(delay);
        tail = merge;
      } else {
        const conv = ctx.createConvolver();
        conv.buffer = makeReverbImpulse(ctx, eff);
        const wet = ctx.createGain();
        wet.gain.value = Math.max(0, Math.min(1, eff.mix ?? 0.35));
        const dry = ctx.createGain();
        dry.gain.value = 1 - wet.gain.value;
        const merge = ctx.createGain();
        tail.connect(dry);
        dry.connect(merge);
        tail.connect(conv);
        conv.connect(wet);
        wet.connect(merge);
        tail = merge;
      }
    }
    tail.connect(gain);
    let out: AudioNode = gain;
    if (panner) {
      gain.connect(panner);
      out = panner;
    }
    buses.set(id, { spec, input, gain, panner, tail: out });
    params.set(id, {
      id,
      gain: spec.gain ?? 1,
      pan: spec.pan ?? 0,
      mute: spec.mute ?? false,
      solo: spec.solo ?? false,
    });
  }
  // 父链接线（父总线的效果输入即子总线的汇入点）
  for (const [id, bus] of buses) {
    if (id === MASTER_BUS) {
      bus.tail.connect(ctx.destination);
      continue;
    }
    const parentId =
      bus.spec.parent && buses.has(bus.spec.parent)
        ? bus.spec.parent
        : MASTER_BUS;
    bus.tail.connect(buses.get(parentId)!.input);
  }
  // 发送（预览端用节点直接实现，与导出端语义一致）
  for (const send of graph?.sends ?? []) {
    const from = buses.get(send.from);
    const to = buses.get(send.to);
    if (!from || !to) continue;
    const amount = ctx.createGain();
    amount.gain.value = send.amount;
    from.tail.connect(amount);
    amount.connect(to.input);
  }
  for (const id of buses.keys())
    writeBusParams(buses, params, id, 0, ctx.currentTime);
  return { buses, params };
}

/** 计算并应用单总线有效参数（solo 期间未 solo 的总线静音；master 不受 solo 影响） */
export function applyBusParams(
  env: PlayerEnv,
  id: BusId,
  rampMs: number,
): void {
  const when = Math.max(env.ctx.currentTime, env.ctxSecOf(env.nowMs()));
  writeBusParams(env.buses, env.busParams, id, rampMs, when);
}

function writeBusParams(
  buses: Map<BusId, BusNode>,
  busParams: Map<BusId, BusUpdate>,
  id: BusId,
  rampMs: number,
  when: number,
): void {
  const bus = buses.get(id);
  if (!bus) return;
  const p = busParams.get(id);
  if (!p) return;
  const soloActive = [...busParams.entries()].some(
    ([b, v]) => b !== MASTER_BUS && v.solo,
  );
  const muted = p.mute || (soloActive && !p.solo && id !== MASTER_BUS);
  const target = muted ? 0 : p.gain;
  const param = bus.gain.gain;
  // 测试替身可能只实现 setValueAtTime/linearRamp（无 cancelScheduledValues）——可选调用
  if (typeof param.cancelScheduledValues === "function")
    param.cancelScheduledValues(when);
  param.setValueAtTime(param.value, when);
  if (rampMs > 0) param.linearRampToValueAtTime(target, when + rampMs / 1000);
  else param.setValueAtTime(target, when);
  if (bus.panner) {
    const pan = bus.panner.pan;
    if (typeof pan.cancelScheduledValues === "function")
      pan.cancelScheduledValues(when);
    pan.setValueAtTime(pan.value, when);
    if (rampMs > 0)
      pan.linearRampToValueAtTime(
        Math.max(-1, Math.min(1, p.pan)),
        when + rampMs / 1000,
      );
    else pan.setValueAtTime(Math.max(-1, Math.min(1, p.pan)), when);
  }
}

/** 确定性混响 IR（衰减噪声；预览端音色近似，时序与导出端一致） */
function makeReverbImpulse(
  ctx: AudioContext,
  spec: { roomSize?: number; damping?: number },
): AudioBuffer {
  const seconds = 0.6 + (spec.roomSize ?? 0.7) * 1.6;
  const frames = Math.max(1, Math.round(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
  const rnd = seededRandom(6789);
  const decay = 2.2 + (spec.damping ?? 0.4) * 2;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      data[i] = (rnd() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buffer;
}
