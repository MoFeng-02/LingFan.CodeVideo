/**
 * 运行期 spawn 的物化：帧内只登记链壳，异步 setup 在帧边界补完。
 * 帧内不得等待 I/O 与墙钟——链从「严格晚于 spawn 时刻的第一个采样点」整点开始，
 * 内容与本地时间 0 对齐；同一份剧本+同一份推演，结果与 I/O 快慢无关。
 */
import type { Ms } from "@lingfan-video/contracts";
import { mergeSegmentGraph } from "./audio-graph";
import {
  compileScene,
  contentEndOf,
  isThenable,
  makeSetupEnv,
} from "./compile-scene";
import { makeRenderError } from "./error";
import type { PendingSpawn, SpawnChain, TimelineState } from "./engine-types";
import { overlapOffset } from "./timeline-spans";
import type { SceneInternal } from "../../domain/simulation/types";

/** 链编译游标：可跨「异步 setup 中断」保存与恢复 */
export interface WalkChainCursor {
  /** 内容末点（全局毫秒） */
  cs: Ms;
  /** 链上 body 的 prev 传参 */
  prev: unknown;
  /** 已见过的场景 id（成环检测） */
  seen: Set<string>;
  /** 上一段声明的重叠窗 */
  pendingOverlap: Ms;
}

/**
 * 一次链编译的结果：要么走到链尾（只有游标），要么停在某个未完成的异步 setup 上。
 */
export interface WalkChainOutcome {
  /** 编译游标（可保存后从同一位置继续） */
  cursor: WalkChainCursor;
  /** 遇到异步 setup：链暂停，等这一 Promise 在帧边界补完 */
  wait?: { head: SceneInternal<unknown>; promise: PromiseLike<unknown> };
}

/**
 * 从游标继续编译一条链，直到链尾或第一个未完成的异步 setup。
 * setup 只跑一次（`setupDone` 记账）；中断时把「待继续的场景」交回调用方。
 *
 * @param state 引擎状态（setup 记账、总线图合并）
 * @param chain 被编译的链（段窗口直接追加到 `chain.spans`）
 * @param head 本次继续编译的链头场景（恢复时是那个 setup 未完成的场景）
 * @param chainFps 链级继承帧率；缺省 = 引擎基础帧率
 * @param start 起始游标（内容末点、prev 传参、成环检测集合、待接的重叠窗）
 * @returns 走到链尾的游标，或停在异步 setup 上的游标 + 待完成的 Promise
 */
export function walkChain(
  state: TimelineState,
  chain: SpawnChain,
  head: SceneInternal<unknown>,
  chainFps: number | undefined,
  start: WalkChainCursor,
): WalkChainOutcome {
  const cursor: WalkChainCursor = {
    cs: start.cs,
    prev: start.prev,
    seen: new Set(start.seen),
    pendingOverlap: start.pendingOverlap,
  };
  let sc: SceneInternal<unknown> | undefined = head;
  // 恢复时 head 已在 seen 里（它的 setup 正等着）：首轮必须放行，否则整段被跳过
  let entered = false;
  while (sc && (!entered || !cursor.seen.has(sc.id))) {
    entered = true;
    cursor.seen.add(sc.id);
    if (sc.setup && !state.setupDone.has(sc)) {
      state.setupDone.add(sc);
      const result = sc.setup(makeSetupEnv(state, sc));
      if (isThenable(result))
        return { cursor, wait: { head: sc, promise: result } };
    }
    const seg = compileScene(state, sc, cursor.prev, chainFps);
    mergeSegmentGraph(state, seg);
    cursor.prev = seg.bodyResult;
    // 链长 = 实际内容：声明池比单元窗口长时按窗口算（空池不算链长）
    const len = contentEndOf(seg);
    cursor.cs -= overlapOffset(cursor.pendingOverlap, len, sc.id, cursor.cs);
    chain.spans.push({
      scene: sc,
      seg,
      start: cursor.cs,
      end: cursor.cs + len,
    });
    cursor.cs += len;
    cursor.pendingOverlap = seg.transitionOverlap ?? 0;
    sc = (seg.transitionNext as SceneInternal<unknown> | undefined) ?? sc.next;
  }
  return { cursor };
}

/** 链内容收尾：缺省链长按内容实况回填（forever / 显式 duration 由参数定死） */
function settle(chain: SpawnChain, cursor: WalkChainCursor): void {
  chain.materialized = true;
  if (!chain.fixedEnd) chain.end = cursor.cs;
}

/** 链尾之后的第一个采样点（无则 undefined）：异步链从这里整点开始 */
export type NextSamplePoint = (atMs: Ms) => Ms | undefined;

/**
 * 运行期 spawn 的入口：立刻登记链壳并编译到第一个异步 setup 为止。
 * 同步 setup 的链当场编译完，行为与以前一致（从 spawn 时刻开始）。
 *
 * 同 key 且时间窗重叠的活跃链已存在时直接返回它（续接，不新建）；否则登记链壳、
 * 版本号自增，再编译。异步 setup 的链先返回未物化的壳，帧边界补完。
 *
 * @param state 引擎状态
 * @param key 去重键（同 key 重叠 → 续接）
 * @param head 链头场景
 * @param start 链起点（全局毫秒）；异步 setup 的链会在物化时平移到下一个采样点
 * @param duration 链长（毫秒）；`undefined` = 按内容实况回填，`Infinity` = forever
 * @param chainFps 链级继承帧率；缺省 = 引擎基础帧率
 * @returns 链（新建的或已存在的续接链）
 */
export function spawnChain(
  state: TimelineState,
  key: string,
  head: SceneInternal<unknown>,
  start: Ms,
  duration: Ms | undefined,
  chainFps?: number,
): SpawnChain {
  const end =
    duration === undefined
      ? start
      : duration === Infinity
        ? Infinity
        : start + duration;
  const overlapWindow =
    duration === undefined || duration === Infinity ? 1 : duration;
  const existing = state.spawnChains.find(
    (c) =>
      c.key === key &&
      !c.killed &&
      start < c.end &&
      start + overlapWindow > c.start,
  );
  if (existing) return existing;
  const chain: SpawnChain = {
    key,
    spans: [],
    start,
    end,
    killed: false,
    materialized: false,
    fixedEnd: duration !== undefined,
  };
  state.spawnChains.push(chain);
  state.timelineEpoch++;
  const outcome = walkChain(state, chain, head, chainFps, {
    cs: start,
    prev: undefined,
    seen: new Set(),
    pendingOverlap: 0,
  });
  if (outcome.wait) {
    const pending: PendingSpawn = {
      chain,
      head: outcome.wait.head,
      promise: outcome.wait.promise,
      chainFps,
      cursor: outcome.cursor.cs,
      prev: outcome.cursor.prev,
      seen: outcome.cursor.seen,
      pendingOverlap: outcome.cursor.pendingOverlap,
    };
    state.pendingSpawns.push(pending);
    return chain;
  }
  settle(chain, outcome.cursor);
  return chain;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 帧边界物化：等已完成的 setup，把已编译前缀整体平移到下一个采样点，继续编译。
 * 在 `sink.writeFrame` 之后调用——这一帧已经交出去了，不影响帧序。
 *
 * 一轮处理当帧登记的全部待物化链；继续编译时又遇到异步 setup 的链重新入队，循环到清空。
 * 没有后续采样点的链安静收掉（置 killed，不会半截出现）。
 *
 * @param state 引擎状态（读取并清空 `pendingSpawns`）
 * @param nextPoint 取出「严格晚于某时刻的第一个采样点」；没有后续点位时返回 `undefined`
 * @throws RenderError（kind = spec_violation）运行期 spawn 的 setup 失败
 */
export async function flushPendingSpawns(
  state: TimelineState,
  nextPoint: NextSamplePoint,
): Promise<void> {
  while (state.pendingSpawns.length > 0) {
    const batch = state.pendingSpawns;
    state.pendingSpawns = [];
    for (const pending of batch) {
      try {
        await pending.promise;
      } catch (err) {
        throw makeRenderError(
          "spec_violation",
          pending.head.id,
          pending.chain.start,
          "运行期 spawn 的 setup 失败",
          undefined,
          describeError(err),
        );
      }
      const boundary = nextPoint(pending.chain.start);
      if (boundary === undefined) {
        // 没有后续采样点：链来不及出现，安静收掉
        pending.chain.killed = true;
        pending.chain.materialized = true;
        state.timelineEpoch++;
        continue;
      }
      const delta = boundary - pending.chain.start;
      if (delta !== 0) {
        for (const span of pending.chain.spans) {
          span.start += delta;
          span.end += delta;
        }
      }
      pending.chain.start = boundary;
      const outcome = walkChain(
        state,
        pending.chain,
        pending.head,
        pending.chainFps,
        {
          cs: pending.cursor + delta,
          prev: pending.prev,
          seen: pending.seen,
          pendingOverlap: pending.pendingOverlap,
        },
      );
      state.timelineEpoch++;
      if (outcome.wait) {
        state.pendingSpawns.push({
          chain: pending.chain,
          head: outcome.wait.head,
          promise: outcome.wait.promise,
          chainFps: pending.chainFps,
          cursor: outcome.cursor.cs,
          prev: outcome.cursor.prev,
          seen: outcome.cursor.seen,
          pendingOverlap: outcome.cursor.pendingOverlap,
        });
      } else {
        settle(pending.chain, outcome.cursor);
      }
    }
  }
}
