import type {
  AudioGraph,
  BusAutomation,
  BusHandle,
  BusId,
  BusPoint,
  BusSpec,
  BusUpdate,
  DuckRule,
  KillOptions,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import type { CompiledSegment } from "../../domain/simulation/types";
import type {
  BusParams,
  BusRampState,
  EvalDeps,
  ParamRamp,
  TimelineState,
} from "./engine-types";
import { makeRenderError } from "./error";

const DEFAULT_PARAMS: BusParams = { gain: 1, pan: 0, mute: false, solo: false };

/** 段内登记期声明汇入全时间线图（同 id / 同 from→to 覆盖，后声明为准） */
export function mergeSegmentGraph(
  state: TimelineState,
  seg: CompiledSegment,
): void {
  for (const spec of seg.buses) state.busSpecs.set(spec.id, spec);
  for (const spec of seg.sends)
    state.sends.set(`${spec.from}->${spec.to}`, spec);
  for (const rule of seg.ducks)
    state.ducks.set(`${rule.from}->${rule.to}`, rule);
}

/** 运行期懒建拓扑：只补不存在（登记期声明优先，运行期不覆盖已有规格） */
export function ensureBusSpec(
  state: TimelineState,
  id: BusId,
  spec: Omit<BusSpec, "id">,
): void {
  if (!state.busSpecs.has(id)) state.busSpecs.set(id, { ...spec, id });
}

/** 运行期补登记发送（同 from→to 覆盖） */
export function registerSend(state: TimelineState, spec: SendSpec): void {
  state.sends.set(`${spec.from}->${spec.to}`, spec);
}

/** 运行期补登记侧链规则（同 from→to 覆盖） */
export function registerDuck(state: TimelineState, rule: DuckRule): void {
  state.ducks.set(`${rule.from}->${rule.to}`, rule);
}

/** 总线参数当前值（未登记 = 全默认；规格里的静态值在采样首点生效） */
function paramsOf(state: TimelineState, id: BusId): BusParams {
  const spec = state.busSpecs.get(id);
  const base: BusParams = spec
    ? {
        gain: spec.gain ?? 1,
        pan: spec.pan ?? 0,
        mute: spec.mute ?? false,
        solo: spec.solo ?? false,
      }
    : { ...DEFAULT_PARAMS };
  return state.busParams.get(id) ?? base;
}

/** 过渡曲线求值：起点之前保持起点值、终点之后保持目标值、区间内线性 */
function rampValue(ramp: ParamRamp, atMs: Ms): number {
  if (atMs <= ramp.fromMs) return ramp.from;
  const end = ramp.fromMs + ramp.ms;
  if (atMs >= end) return ramp.to;
  return ramp.from + ((ramp.to - ramp.from) * (atMs - ramp.fromMs)) / ramp.ms;
}

/**
 * 某一时刻的有效参数 = 目标值叠加未完成的过渡。
 * 过渡按帧采样、帧间由混音端线性插值，因此斜坡终点最多晚一帧对齐到采样点。
 */
function paramsAt(state: TimelineState, id: BusId, atMs: Ms): BusParams {
  const target = paramsOf(state, id);
  const ramps = state.busRamps.get(id);
  if (!ramps) return target;
  return {
    ...target,
    gain: ramps.gain ? rampValue(ramps.gain, atMs) : target.gain,
    pan: ramps.pan ? rampValue(ramps.pan, atMs) : target.pan,
  };
}

/** 已完成的过渡出清（未完成的保留；全部完成即移除该总线的记录） */
function pruneRamps(state: TimelineState, id: BusId, atMs: Ms): void {
  const ramps = state.busRamps.get(id);
  if (!ramps) return;
  if (ramps.gain && atMs >= ramps.gain.fromMs + ramps.gain.ms)
    delete ramps.gain;
  if (ramps.pan && atMs >= ramps.pan.fromMs + ramps.pan.ms) delete ramps.pan;
  if (!ramps.gain && !ramps.pan) state.busRamps.delete(id);
}

/**
 * 登记参数过渡：起点取当前有效值（在途过渡的当前插值），目标写入即时参数。
 * rampMs ≤ 0 = 立即生效并清掉该参数的在途过渡。
 */
function registerRamp(
  state: TimelineState,
  id: BusId,
  key: keyof Pick<BusParams, "gain" | "pan">,
  to: number,
  rampMs: Ms | undefined,
): void {
  const from = paramsAt(state, id, state.nowMs)[key];
  const ms = Math.max(0, rampMs ?? 0);
  const ramps: BusRampState = state.busRamps.get(id) ?? {};
  if (ms > 0) ramps[key] = { fromMs: state.nowMs, ms, from, to };
  else delete ramps[key];
  if (ramps.gain || ramps.pan) state.busRamps.set(id, ramps);
  else state.busRamps.delete(id);
}

/**
 * 采样点记录：逐帧记录，不做「相邻相同值去重」——去重会把「保持段」折叠成
 * 稀疏点，混音端的线性插值就会把恒定段提前斜坡化（kill fadeOut 曾被吃掉
 * 前一段）。帧内点足够密（30/s），插值误差 ≤ 一帧。
 */
function pushPoint(state: TimelineState, id: BusId, point: BusPoint): void {
  const list = state.busPoints.get(id);
  if (!list) {
    state.busPoints.set(id, [point]);
    return;
  }
  const last = list[list.length - 1];
  if (last && point.atMs <= last.atMs)
    point = { ...point, atMs: last.atMs + 1 };
  list.push(point);
}

/** 逐帧采样：所有已登记总线（含运行期懒建的）在当前时刻的参数点 */
export function sampleBuses(deps: EvalDeps, t: Ms): void {
  const { state } = deps;
  if (state.busSpecs.size === 0 && state.busParams.size === 0) return;
  const ids = new Set<string>([
    ...state.busSpecs.keys(),
    ...state.busParams.keys(),
  ]);
  for (const id of ids) {
    const p = paramsAt(state, id, t);
    const kill = state.busKill.get(id);
    // 消亡窗口：窗口内继续出参数（引擎不改你的曲线），窗口结束才静音
    let gain = p.gain;
    let muted = p.mute;
    if (kill) {
      if (state.nowMs >= kill.until) muted = true;
      else if (state.nowMs > kill.from && kill.until > kill.from) {
        const k = Math.min(
          1,
          (state.nowMs - kill.from) / (kill.until - kill.from),
        );
        gain = p.gain * (1 - k);
      }
    }
    pushPoint(state, id, {
      atMs: t,
      gain,
      pan: p.pan,
      mute: muted,
      solo: p.solo,
    });
    pruneRamps(state, id, t);
  }
}

/**
 * 总线参数更新（预览端据此同步实时音频图；无 setBus 的实现忽略）。
 * 过渡时长取相邻两次下发的帧间隔，预览端按同一线性曲线跟随，与离线混音一致。
 */
export function flushBusUpdates(state: TimelineState, t: Ms): BusUpdate[] {
  const rampMs = Math.max(0, t - (state.busFlushAt ?? t));
  state.busFlushAt = t;
  const out: BusUpdate[] = [];
  const ids = new Set<string>([
    ...state.busSpecs.keys(),
    ...state.busParams.keys(),
  ]);
  for (const id of ids) {
    const p = paramsAt(state, id, t);
    out.push({
      id,
      gain: p.gain,
      pan: p.pan,
      mute: p.mute,
      solo: p.solo,
      at: t,
      rampMs,
    });
  }
  return out;
}

/** 运行期总线句柄：参数记录进轨迹（导出可复算），预览端即时生效 */
export function makeBusHandle(deps: EvalDeps, id: BusId): BusHandle {
  const { state } = deps;
  if (!state.inCallback)
    throw makeRenderError(
      "spec_violation",
      id,
      0,
      `ctx.bus(${JSON.stringify(id)}) 只能在回调内调用（时间线语义在回调时间点生效）`,
    );
  const spec = state.busSpecs.get(id);
  // 参数写入只改即时目标值；轨迹点统一由帧末 sampleBuses 记录（一帧一点，避免重复点）
  const write = (patch: Partial<BusParams>): void => {
    state.busParams.set(id, { ...paramsOf(state, id), ...patch });
  };
  /** 带过渡地改一个参数：先按当前有效值登记斜坡，再落目标值 */
  const setParam = (key: "gain" | "pan", to: number, rampMs?: Ms): void => {
    registerRamp(state, id, key, to, rampMs);
    write(key === "gain" ? { gain: to } : { pan: to });
  };
  return {
    id,
    get alive() {
      const kill = state.busKill.get(id);
      if (!spec && !state.busParams.has(id)) return false;
      if (!kill) return true;
      return state.nowMs < kill.until;
    },
    gain(value: number, rampMs?: Ms): void {
      setParam("gain", Math.max(0, value), rampMs);
    },
    pan(value: number, rampMs?: Ms): void {
      setParam("pan", Math.max(-1, Math.min(1, value)), rampMs);
    },
    mute(value: boolean): void {
      write({ mute: value });
    },
    solo(value: boolean): void {
      write({ solo: value });
    },
    kill(options?: KillOptions): void {
      const fade = Math.max(0, options?.fadeOut ?? 0);
      const from = state.nowMs;
      if (fade > 0) state.busKill.set(id, { from, until: from + fade });
      else {
        state.busKill.set(id, { from, until: from });
        write({ mute: true });
      }
    },
  };
}

/** 运行期懒建/补登记总线（拓扑只能登记期定，这里只保证参数面存在） */
export function ensureBusParams(state: TimelineState, id: BusId): void {
  if (!state.busParams.has(id)) state.busParams.set(id, paramsOf(state, id));
}

/**
 * 构建整条音频图并校验拓扑：
 * - 未知父总线 / 未知发送与压制端点 → 回落 master（宽容，但记录）——不因一个拼写把整条声轨弄废；
 * - 成环（父链）→ spec_violation（无定义结果，必须显式报错）。
 */
export function buildAudioGraph(
  state: TimelineState,
  sceneId: string,
): AudioGraph {
  const buses: BusSpec[] = [];
  const declared = new Set<string>([MASTER_BUS, ...state.busSpecs.keys()]);
  const resolve = (id: BusId): BusId => (declared.has(id) ? id : MASTER_BUS);
  for (const spec of state.busSpecs.values()) {
    const parent =
      spec.id === MASTER_BUS ? undefined : resolve(spec.parent ?? MASTER_BUS);
    if (parent === spec.id)
      throw makeRenderError(
        "spec_violation",
        spec.id,
        0,
        `总线 ${spec.id} 的父总线不能是自己`,
      );
    buses.push({ ...spec, parent });
  }
  // 父链成环检测（每条最多走 bus 数量步）
  for (const spec of buses) {
    let cur: BusId | undefined = spec.parent;
    for (let i = 0; cur !== undefined && i <= buses.length + 1; i++) {
      if (cur === spec.id)
        throw makeRenderError(
          "spec_violation",
          spec.id,
          0,
          `总线父链成环（${spec.id} → … → ${spec.id}）`,
        );
      cur = buses.find((b) => b.id === cur)?.parent;
    }
  }
  const sends: readonly SendSpec[] = [...state.sends.values()].map((s) => ({
    ...s,
    from: resolve(s.from),
    to: resolve(s.to),
  }));
  const ducks: readonly DuckRule[] = [...state.ducks.values()].map((d) => ({
    ...d,
    from: resolve(d.from),
    to: resolve(d.to),
  }));
  const automation: BusAutomation[] = [];
  for (const [bus, points] of state.busPoints) {
    const sorted = [...points].sort((a, b) => a.atMs - b.atMs);
    automation.push({ bus, points: sorted });
  }
  void sceneId;
  return { buses, sends, ducks, automation };
}
