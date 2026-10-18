/**
 * 时间线构建：主链展开成段窗口，spawn 链展开成各自的段窗口，再把段内声明
 * （画面层、声音、总线自动化）全局化到绝对时间线。
 *
 * 构建期允许等待 setup 的 I/O（资产加载），求值期不允许：所以这里先把所有
 * 链上场景的 setup 解析完，再同步编译；运行期 spawn 的异步 setup 走另一条路
 * （帧边界物化，见 runtime-spawn）。
 */
import type { AutomationPoint, BusId, Ms } from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import type {
  CompiledSegment,
  SceneEntry,
  SceneInternal,
} from "../../domain/simulation/types";
import { mergeSegmentGraph } from "./audio-graph";
import { installAutomation } from "./bus-automation";
import { pushVoice } from "./audio-runtime";
import { compileScene, isThenable, makeSetupEnv } from "./compile-scene";
import { makeRenderError } from "./error";
import { walkChain } from "./runtime-spawn";
import { overlapOffset } from "./timeline-spans";
import type { ChainSpan, SpawnChain, TimelineState } from "./engine-types";

/**
 * 重入复位（computeAt/collect/run 共用一引擎时防串台）。
 *
 * 时间线结构、声音记录、去重键、总线状态全部清空；setup 记账也重来一次
 * （资产按本次推演的解码器重新加载，跨推演不共享句柄）。
 *
 * @param state 引擎状态（原地清空，不替换对象）
 */
export function resetTimeline(state: TimelineState): void {
  state.spans = [];
  state.spawnChains.length = 0;
  state.audioVoices.length = 0;
  state.voiceSeq = 0;
  state.deadUnits.clear();
  state.dyingUnits.clear();
  state.onceKeys.clear();
  state.busSpecs.clear();
  state.sends.clear();
  state.ducks.clear();
  state.busParams.clear();
  state.busRamps.clear();
  state.busFlushAt = undefined;
  state.busPoints.clear();
  state.busKill.clear();
  state.busAutomation.clear();
  state.selfPaced.clear();
  state.layers.clear();
  state.pendingSpawns.length = 0;
  state.timelineEpoch = 0;
  state.timelineEnd = 0;
  state.nowMs = 0;
  state.inCallback = false;
  // setup 每次推演重跑一次（资产按本次推演的解码器重新加载，跨推演不共享句柄）
  state.setupDone = new WeakSet();
}

/**
 * 主链时间线构建：成环检测、prev 链式传参、transition 优先、spawn 链展开。
 *
 * 段起点由「上一段声明的重叠窗」前移；末点取内容实况（`activeEnd` 提前收窗）。
 * 终界 = 主链池尾与有界 spawn 链内容末点的较大者，forever 链的寿命在终界确定后才夹取。
 * 收尾把层/声音/自动化从段内相对时刻全局化。
 *
 * @param state 引擎状态（先复位再写入）
 * @param head 主链头场景
 * @throws RenderError（kind = spec_violation）剧本链成环、重叠窗不小于段长、构建期遇到异步 setup
 */
export async function buildTimeline(
  state: TimelineState,
  head: SceneEntry,
): Promise<void> {
  resetTimeline(state);
  let start: Ms = 0;
  let pendingOverlap: Ms = 0; // 上一段声明的重叠窗：本段提前这么多开始
  let cur: SceneEntry | undefined = head;
  let prev: unknown; // body(prev) 链式传参
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.id))
      throw makeRenderError("spec_violation", cur.id, start, "剧本链成环");
    seen.add(cur.id);
    // 结构入口 → 编译面：引擎只在链上推进，prev 的具体类型不参与
    const scene = cur as SceneInternal<unknown>;
    // setup 先于 body：资产与解码只跑一次，且必须在任何帧求值之前完成
    await ensureSetup(state, scene);
    const seg = compileScene(state, scene, prev);
    prev = seg.bodyResult;
    const spanLen = seg.activeEnd ?? seg.duration;
    // 重叠窗是两段共享的时长：吃满整段就等于本段没有独立窗口
    start -= overlapOffset(pendingOverlap, spanLen, cur.id, start);
    const end = start + spanLen;
    state.spans.push({ scene, seg, start, end });
    mergeSegmentGraph(state, seg);
    await expandSpawns(state, seg, start, 0);
    start = end;
    pendingOverlap = seg.transitionOverlap ?? 0;
    cur = seg.transitionNext
      ? (seg.transitionNext as SceneInternal<unknown>)
      : cur.next;
  }
  // 终界 = 内容上界：主链池尾与有界 spawn 链内容末点的较大者
  // （链可以在主链池尾之后仍有内容，此时视频/音频都必须跑到那里，不能只按主链裁剪）
  let end = start;
  for (const c of state.spawnChains)
    if (c.end !== Infinity) end = Math.max(end, c.end);
  state.timelineEnd = end;
  // forever spawn 寿命 = 总链尾：终界确定后再夹取
  for (const c of state.spawnChains) if (c.end === Infinity) c.end = end;
  materializeLayers(state);
  materializeAudio(state);
  materializeAutomation(state);
}

/**
 * 全时间线遍历「段出现」：spawn 链（forever 循环圈按内容时长平移展开）+ 主链。
 * 声音与参数计划共用同一份遍历，循环圈的全局化口径只有一处。
 */
function forEachOccurrence(
  state: TimelineState,
  visit: (seg: CompiledSegment, spanStart: Ms, spanEnd: Ms) => void,
): void {
  const walkSpans = (spans: ChainSpan[], shift: Ms = 0): void => {
    for (const span of spans)
      visit(span.seg, span.start + shift, span.end + shift);
  };
  for (const c of state.spawnChains) {
    if (c.killed) continue;
    walkSpans(c.spans);
    const last = c.spans[c.spans.length - 1];
    const contentLen = last ? last.end - c.start : 0;
    if (contentLen > 0 && c.end - c.start > contentLen) {
      // forever 循环重放：按圈数平移展开（与画面回卷同相位）
      const loops = Math.ceil((c.end - c.start) / contentLen);
      for (let k = 1; k < loops; k++) walkSpans(c.spans, k * contentLen);
    }
  }
  walkSpans(state.spans);
}

/**
 * 画面层全局化：登记期声明（段内锚点）→ 绝对故事时间，交给帧宿主去配对渲染面。
 *
 * 同一 id 多次登记 = 最后一处声明为准（与 bus 的覆盖语义一致）：永久 spawn 与
 * forever 重放都会让同一段出现多次，取最后一次即「最终生效区间」。
 * 区间终点缺省取该次出现的段窗末尾。
 */
function materializeLayers(state: TimelineState): void {
  forEachOccurrence(state, (seg, spanStart, spanEnd) => {
    for (const l of seg.layers) {
      const from = spanStart + l.fromMs;
      const to = l.toMs === undefined ? spanEnd : spanStart + l.toMs;
      if (to <= from) continue;
      state.layers.set(l.declaration.id, {
        ...l.declaration,
        from,
        to,
      });
    }
  });
}

/**
 * 声音全局化：登记期声明（段内锚点）→ 全局时间线声音。
 * 锚点已落到段窗外（transition 提前收窗等）的声明不发声——声明位置就是语义。
 */
function materializeAudio(state: TimelineState): void {
  forEachOccurrence(state, (seg, spanStart, spanEnd) => {
    for (const a of seg.audio) {
      const at = spanStart + a.atMs;
      if (at >= spanEnd) continue;
      pushVoice(state, a.clip, at, a.options, a.synth);
    }
  });
}

/**
 * 参数计划全局化：段内相对时刻 → 全局时刻（forever 循环圈同相位平移）。
 * 未知总线回落 master——与发送/压制端点同一容错口径（不因一个拼写废掉整条声轨）。
 * 每个点只在其段活跃窗口内生效；同一时刻多点按登记顺序叠加（后者覆盖同名参数）。
 */
function materializeAutomation(state: TimelineState): void {
  const declared = new Set<string>([MASTER_BUS, ...state.busSpecs.keys()]);
  const resolve = (id: BusId): BusId => (declared.has(id) ? id : MASTER_BUS);
  const byBus = new Map<BusId, AutomationPoint[]>();
  forEachOccurrence(state, (seg, spanStart, spanEnd) => {
    for (const spec of seg.automations) {
      const bus = resolve(spec.bus);
      let points = byBus.get(bus);
      if (!points) {
        points = [];
        byBus.set(bus, points);
      }
      for (const p of spec.points) {
        const at = spanStart + p.atMs;
        if (at >= spanEnd) continue;
        points.push(at === p.atMs ? p : { ...p, atMs: at });
      }
    }
  });
  for (const [bus, points] of byBus) {
    // 稳定排序（ES 保证）：同一时刻保持登记顺序
    points.sort((a, b) => a.atMs - b.atMs);
    installAutomation(state, bus, points);
  }
}
/**
 * 构建期解析 setup：推演开始前完成资产加载等 I/O，之后逐帧求值全同步。
 * 同一场景在本次推演里只跑一次 setup（资产只解码一次）。
 */
async function ensureSetup(
  state: TimelineState,
  scene: SceneInternal<unknown>,
): Promise<void> {
  if (!scene.setup || state.setupDone.has(scene)) return;
  state.setupDone.add(scene);
  const result = scene.setup(makeSetupEnv(state, scene));
  if (isThenable(result)) await result;
}

/**
 * 沿 next 链预解析 setup（next 已含 transition 目标）：同步 buildChain 之前必须做完。
 *
 * 只遍历一次（按对象身份去重），因此同一场景出现多次时 setup 仍只跑一次
 * （由 `setupDone` 记账保证）。
 *
 * @param state 引擎状态（读 setup 记账与注入面）
 * @param head 链头场景
 */
export async function ensureSetupChain(
  state: TimelineState,
  head: SceneInternal<unknown>,
): Promise<void> {
  const seen = new Set<object>();
  let cur: SceneInternal<unknown> | undefined = head;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    await ensureSetup(state, cur);
    cur = cur.next as SceneInternal<unknown> | undefined;
  }
}

/**
 * 展开 spawn 链（编译期锚定的）；depth 帽 3（嵌套 spawn）。链登记由 buildChain 内完成，此处不再返回。
 *
 * 每个 spawn 先解析链上场景的 setup（可能异步），保证随后的编译是全同步的；
 * 子链自己的 spawn 递归展开（深度 +1）。
 *
 * @param state 引擎状态
 * @param seg 已编译的段（读其中的 spawn 声明）
 * @param spanStart 该段在时间线上的起点（全局毫秒）
 * @param depth 当前嵌套深度（0 起；超过 3 直接返回，不再展开）
 */
export async function expandSpawns(
  state: TimelineState,
  seg: CompiledSegment,
  spanStart: Ms,
  depth: number,
): Promise<void> {
  if (depth > 3) return;
  for (const s of seg.spawns) {
    // 链上场景的 setup 先解析（可能异步）；之后 buildChain 的编译才是同步的
    await ensureSetupChain(state, s.scene as SceneInternal<unknown>);
    const chain = buildChain(
      state,
      s.key,
      s.scene as SceneInternal<unknown>,
      spanStart + s.startGlobal,
      s.forever ? Infinity : s.chainDuration,
      s.chainFps,
    );
    if (!chain) continue;
    for (const sp of chain.spans)
      await expandSpawns(state, sp.seg, sp.start, depth + 1);
  }
}

/**
 * 构造一条链并登记（同 key 活跃链已存在 → 返回 undefined，续接语义）；forever 端点先记 Infinity。
 *
 * 链长只有显式 `duration` 才定死（`fixedEnd`），否则按内容实况回填——
 * transition 短路或单元窗口更早结束时，声明池长会虚高。
 *
 * @param state 引擎状态（链表与版本号都在这里）
 * @param key 去重键（同 key 且时间窗重叠视为同一链）
 * @param head 链头场景
 * @param start 链起点（全局毫秒）
 * @param duration 链长（毫秒）；`Infinity` = forever，寿命到时间线尾或显式 kill
 * @param chainFps 链级继承帧率；缺省 = 引擎基础帧率
 * @returns 新建的链；同 key 活跃链已存在时 `undefined`（调用方按续接处理）
 * @throws RenderError（kind = spec_violation）链上场景 setup 返回 Promise（构建期不得等待）
 */
export function buildChain(
  state: TimelineState,
  key: string,
  head: SceneInternal<unknown>,
  start: Ms,
  duration: Ms,
  chainFps?: number,
): SpawnChain | undefined {
  if (
    state.spawnChains.some(
      (c) =>
        c.key === key &&
        !c.killed &&
        start < c.end &&
        start + duration > c.start,
    )
  )
    return undefined;
  const chain: SpawnChain = {
    key,
    spans: [],
    start,
    end: duration === Infinity ? Infinity : start + duration,
    killed: false,
    materialized: false,
    fixedEnd: true,
  };
  state.spawnChains.push(chain);
  const outcome = walkChain(state, chain, head, chainFps, {
    cs: start,
    prev: undefined,
    seen: new Set(),
    pendingOverlap: 0,
  });
  // 构建期不允许异步 setup：要么已在 ensureSetupChain 里解析完，要么明确报错（帧内不得等待）
  if (outcome.wait) {
    state.spawnChains.pop();
    throw makeRenderError(
      "spec_violation",
      outcome.wait.head.id,
      state.nowMs,
      "场景 setup 返回 Promise：运行期 spawn 不能等待资产加载；请在登记期 spawn 该场景，或把 setup 写成同步",
    );
  }
  chain.materialized = true;
  if (duration !== Infinity) chain.end = outcome.cursor.cs; // 修正估算链长（transition 短路虚高）
  state.timelineEpoch++;
  return chain;
}
