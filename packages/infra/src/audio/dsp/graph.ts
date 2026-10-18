/** 总线图结构运算：拓扑排序、父链解析、独奏判定与自动化求值。 */
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

interface BusParams {
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

/** 参数自动化：折点间线性插值，回到折点时直接取端点值 */
function makeAutomation(a: BusAutomation): (ms: Ms) => BusParams {
  const pts = a.points;
  if (pts.length === 0)
    return () => ({ gain: 1, pan: 0, mute: false, solo: false });
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

function anySolo(graph: AudioGraph): boolean {
  if (graph.buses.some((b) => b.solo && b.id !== MASTER_BUS)) return true;
  return graph.automation.some(
    (a) => a.bus !== MASTER_BUS && a.points.some((p) => p.solo),
  );
}

/** 拓扑排序：子→父、send.from→send.to、duck.from→duck.to；成环即错 */
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

function parentOf(buses: Map<BusId, BusSpec>, id: BusId): BusId | undefined {
  if (id === MASTER_BUS) return undefined;
  const p = buses.get(id)?.parent;
  return p && buses.has(p) && p !== id ? p : MASTER_BUS;
}

export { anySolo, makeAutomation, parentOf, topoOrder };
export type { BusParams };
