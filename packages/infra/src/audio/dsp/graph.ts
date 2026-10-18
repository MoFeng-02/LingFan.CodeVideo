/**
 * 总线图结构运算：拓扑排序、父链解析、独奏判定与自动化求值。
 *
 * 只做「图与参数求值」，不碰样本；混音器按这里给出的顺序逐总线处理样本。
 */
import type {
  AudioGraph,
  BusAutomation,
  BusId,
  BusSpec,
  DuckRule,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";

/** 一条总线在某一时刻的有效参数（自动化求值结果；增益与声像都在线性域） */
interface BusParams {
  /** 线性增益倍率（1 = 原样，0 = 静音） */
  gain: number;
  /** 声像位置（-1 全左 .. 1 全右） */
  pan: number;
  /** 是否静音 */
  mute: boolean;
  /** 是否独奏 */
  solo: boolean;
}

/**
 * 参数自动化求值：折点之间对 gain/pan 线性插值。
 *
 * 返回值是带状态的查询函数——内部折点游标只前进、不回退，调用方必须按时间非递减顺序
 * 查询（混音器逐帧推进，天然满足）。mute/solo 是开关量：折点之间取前一个折点的值，
 * 到达后一个折点时刻才切换。没有任何折点时恒为中性参数（增益 1、声像 0、未静音、未独奏）。
 *
 * @param a 某条总线的自动化轨迹（折点按 atMs 递增）
 * @returns 查询函数：全局毫秒 → 该时刻的有效参数
 */
function makeAutomation(a: BusAutomation): (ms: Ms) => BusParams {
  const pts = a.points;
  if (pts.length === 0)
    return () => ({ gain: 1, pan: 0, mute: false, solo: false });
  /** 折点游标：只前进（查询时间须非递减） */
  let idx = 0;
  return (ms: Ms) => {
    while (idx + 1 < pts.length && pts[idx + 1]!.atMs <= ms) idx++;
    const p0 = pts[idx]!;
    const p1 = idx + 1 < pts.length ? pts[idx + 1]! : undefined;
    if (!p1 || p1.atMs === p0.atMs || ms <= p0.atMs) return p0;
    const k = Math.min(1, Math.max(0, (ms - p0.atMs) / (p1.atMs - p0.atMs)));
    return {
      gain: p0.gain + (p1.gain - p0.gain) * k,
      pan: p0.pan + (p1.pan - p0.pan) * k,
      mute: k < 1 ? p0.mute : p1.mute,
      solo: k < 1 ? p0.solo : p1.solo,
    };
  };
}

/**
 * 是否有「独奏」生效：只看非 master 总线——静态 solo，以及其自动化折点上的 solo。
 *
 * 混音器据此把未独奏的非 master 总线整条静音；master 不受独奏影响，
 * 保证独奏声音仍能经 master 送出。
 *
 * @param graph 总线图
 * @returns 任一非 master 总线独奏时为 true
 */
function anySolo(graph: AudioGraph): boolean {
  if (graph.buses.some((b) => b.solo && b.id !== MASTER_BUS)) return true;
  return graph.automation.some(
    (a) => a.bus !== MASTER_BUS && a.points.some((p) => p.solo),
  );
}

/**
 * 总线拓扑排序：保证一条总线被处理时，它的来源（父总线、发送源、侧链来源）已处理完毕。
 *
 * 依赖边有三类：子总线 → 父总线、send.from → send.to、duck.from → duck.to；
 * 指向未登记总线、自环、重复的边直接忽略。Kahn 算法输出处理顺序。
 *
 * @param buses 已登记的 busId → 总线声明
 * @param sends 发送关系
 * @param ducks 侧链压制关系
 * @returns 处理顺序（父总线排在子总线之后）
 * @throws Error name 为 "SpecViolation"：父链/发送/侧链构成环时
 */
function topoOrder(
  buses: Map<BusId, BusSpec>,
  sends: readonly SendSpec[],
  ducks: readonly DuckRule[],
): BusId[] {
  const indeg = new Map<BusId, number>();
  const edges = new Map<BusId, Set<BusId>>();
  for (const id of buses.keys()) {
    indeg.set(id, 0);
    edges.set(id, new Set());
  }
  /** 登记一条依赖边（跳过未登记总线、自环与重复边） */
  const addEdge = (from: BusId, to: BusId): void => {
    if (!buses.has(from) || !buses.has(to) || from === to) return;
    const set = edges.get(from)!;
    if (set.has(to)) return;
    set.add(to);
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
  };
  for (const id of buses.keys()) {
    const p = parentOf(buses, id) ?? MASTER_BUS;
    if (p) addEdge(id, p);
  }
  for (const s of sends) addEdge(s.from, s.to);
  for (const d of ducks) addEdge(d.from, d.to);
  const queue: BusId[] = [];
  for (const [id, n] of indeg) if (n === 0) queue.push(id);
  const out: BusId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of edges.get(id) ?? []) {
      const n = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (out.length !== buses.size)
    throw Object.assign(
      new Error("spec_violation: 音频总线图成环（父链/发送/侧链构成循环）"),
      { name: "SpecViolation" },
    );
  return out;
}

/**
 * 解析父总线：master 没有父；父名未登记或指向自己时退回 master。
 *
 * @param buses 已登记的 busId → 总线声明
 * @param id 子总线 id
 * @returns 父总线 id；master 返回 undefined
 */
function parentOf(buses: Map<BusId, BusSpec>, id: BusId): BusId | undefined {
  if (id === MASTER_BUS) return undefined;
  const p = buses.get(id)?.parent;
  return p && buses.has(p) && p !== id ? p : MASTER_BUS;
}

export { anySolo, makeAutomation, parentOf, topoOrder };
export type { BusParams };
