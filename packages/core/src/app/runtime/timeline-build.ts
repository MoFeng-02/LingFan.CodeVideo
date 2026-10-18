import type { AutomationPoint, BusId, Ms } from "@lingfan-video/contracts";
import { MASTER_BUS } from "@lingfan-video/contracts";
import { compileSegment } from "../../domain/simulation";
import { Recorder } from "../../domain/simulation/dsl";
import type {
  CompiledSegment,
  SceneEntry,
  SceneInternal,
} from "../../domain/simulation/types";
import { mergeSegmentGraph } from "./audio-graph";
import { makeAssetLoader } from "./assets";
import { installAutomation } from "./bus-automation";
import { pushVoice } from "./audio-runtime";
import { makeRenderError } from "./error";
import type { ChainSpan, SpawnChain, TimelineState } from "./engine-types";

/** 重入复位（computeAt/collect/run 共用一引擎时防串台） */
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
  state.timelineEnd = 0;
  state.nowMs = 0;
  state.inCallback = false;
  // setup 每次推演重跑一次（资产按本次推演的解码器重新加载，跨推演不共享句柄）
  state.setupDone = new WeakSet();
  // 资产清单与缓存同样按推演隔离：跨推演的载荷句柄不可复用
  state.assetIndex = null;
  state.assetIndexRead = false;
  state.assetCache.clear();
}

/** 主链时间线构建：成环检测、prev 链式传参、transition 优先、spawn 链展开 */
export async function buildTimeline(
  state: TimelineState,
  head: SceneEntry,
): Promise<void> {
  resetTimeline(state);
  let start: Ms = 0;
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
    const end = start + (seg.activeEnd ?? seg.duration);
    state.spans.push({ scene, seg, start, end });
    mergeSegmentGraph(state, seg);
    await expandSpawns(state, seg, start, 0);
    start = end;
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
/** 编译单段：body 捕获节点流（每次出现都跑——prev 依出现上下文，不能按 id 缓存） */
export function compileScene(
  state: TimelineState,
  scene: SceneInternal<unknown>,
  prev: unknown,
  inheritedFps?: number,
): CompiledSegment {
  const { width, height, fps, headless, canvas } = state.opts;
  const rec = new Recorder(width, height, fps, headless, canvas);
  const result = scene.body(prev as never, rec);
  return compileSegment(
    scene.id,
    scene.duration,
    rec.nodes,
    result,
    fps,
    inheritedFps,
  );
}

/** setup 专用环境：assets 走组合根注入的 AssetSource（core 不认平台 API） */
function makeSetupEnv(
  state: TimelineState,
  scene: SceneInternal<unknown>,
): import("@lingfan-video/contracts").SetupEnv {
  const { width, height, fps, headless, canvas } = state.opts;
  const rec = new Recorder(width, height, fps, headless, canvas);
  const hooks = { load: makeAssetLoader(state, scene.id) };
  void scene;
  return Object.assign(rec, { assets: hooks });
}

/** thenable 判定（不用 instanceof：跨 realm 的 Promise 也要认） */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
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

/** 沿 next 链预解析 setup（next 已含 transition 目标）：同步 buildChain 之前必须做完 */
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
 * 同步解析 setup：运行期 spawn 走这条（帧内不得等待 I/O）。
 * 异步 setup 的场景只能在构建期 spawn，否则明确报错——不静默丢资产。
 */
export function runSetupSync(
  state: TimelineState,
  scene: SceneInternal<unknown>,
): void {
  if (!scene.setup || state.setupDone.has(scene)) return;
  state.setupDone.add(scene);
  const result = scene.setup(makeSetupEnv(state, scene));
  if (isThenable(result))
    throw makeRenderError(
      "spec_violation",
      scene.id,
      state.nowMs,
      "场景 setup 返回 Promise：运行期 spawn 不能等待资产加载；请在登记期 spawn 该场景，或把 setup 写成同步",
    );
}

/** 展开 spawn 链（编译期锚定的）；depth 帽 3（嵌套 spawn）。链登记由 buildChain 内完成，此处不再返回 */
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

/** 段的内容末点：单元窗口上界（无单元时才按声明池长）——声明池是上限不是内容 */
function contentEndOf(seg: CompiledSegment): Ms {
  const declared = seg.activeEnd ?? seg.duration;
  if (seg.units.length === 0) return declared;
  let end = 0;
  for (const u of seg.units) if (u.windowEnd > end) end = u.windowEnd;
  return Math.min(declared, end);
}

/** 构造一条链并登记（同 key 活跃链已存在 → 返回 undefined，续接语义）；forever 端点先记 Infinity */
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
  };
  let cs = start;
  let sc: SceneInternal<unknown> | undefined = head;
  let prev: unknown; // spawn 链独立于主链传参，起点 prev=undefined
  const seen = new Set<string>();
  while (sc && !seen.has(sc.id)) {
    seen.add(sc.id);
    // 运行期 spawn 走同步解析；构建期已预解析过这里是空操作
    runSetupSync(state, sc);
    const seg = compileScene(state, sc, prev, chainFps);
    mergeSegmentGraph(state, seg);
    prev = seg.bodyResult;
    // 链长 = 实际内容：声明池比单元窗口长时按窗口算（空池不算链长）
    const len = contentEndOf(seg);
    chain.spans.push({ scene: sc, seg, start: cs, end: cs + len });
    cs += len;
    sc = (seg.transitionNext as SceneInternal<unknown> | undefined) ?? sc.next;
  }
  if (duration !== Infinity) chain.end = cs; // 修正估算链长（transition 短路虚高）
  state.spawnChains.push(chain);
  return chain;
}

/** span 活跃判定：t 落在 [start,end) 内 */
export function findSpan(spans: ChainSpan[], t: Ms): ChainSpan | undefined {
  return spans.find((s) => t >= s.start && t < s.end);
}

/** forever 链 span 查找：t 超出内容总长后按链内容时长取模回卷（循环重放） */
export function findSpanLooping(
  chain: SpawnChain,
  t: Ms,
): ChainSpan | undefined {
  const span = findSpan(chain.spans, t);
  if (span) return span;
  const last = chain.spans[chain.spans.length - 1];
  if (!last) return undefined;
  const contentLen = last.end - chain.start;
  if (!(contentLen > 0)) return undefined;
  const local = (t - chain.start) % contentLen;
  return findSpan(chain.spans, chain.start + local);
}
