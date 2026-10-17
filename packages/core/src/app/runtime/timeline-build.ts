import type { Ms } from "@lingfan-video/contracts";
import { compileSegment } from "../../domain/simulation";
import { Recorder } from "../../domain/simulation/dsl";
import type {
  CompiledAudio,
  CompiledSegment,
  SceneInternal,
} from "../../domain/simulation/types";
import { makeRenderError } from "./error";
import type { ChainSpan, SpawnChain, TimelineState } from "./engine-types";

/** 重入复位（computeAt/collect/run 共用一引擎时防串台） */
export function resetTimeline(state: TimelineState): void {
  state.spans = [];
  state.spawnChains.length = 0;
  state.audioEvents.length = 0;
  state.deadUnits.clear();
  state.form3.clear();
  state.timelineEnd = 0;
}

/** 主链时间线构建：成环检测、prev 链式传参、transition 优先、spawn 链展开 */
export function buildTimeline(
  state: TimelineState,
  head: SceneInternal<unknown>,
): void {
  resetTimeline(state);
  let start: Ms = 0;
  let cur: SceneInternal<unknown> | undefined = head;
  let prev: unknown; // body(prev) 链式传参
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.id))
      throw makeRenderError("spec_violation", cur.id, start, "剧本链成环");
    seen.add(cur.id);
    const seg = compileScene(state, cur, prev);
    prev = seg.bodyResult;
    const end = start + (seg.activeEnd ?? seg.duration);
    state.spans.push({ scene: cur, seg, start, end });
    expandSpawns(state, seg, start, 0);
    start = end;
    cur = seg.transitionNext
      ? (seg.transitionNext as SceneInternal<unknown>)
      : cur.next;
  }
  state.timelineEnd = start;
  // forever spawn 寿命 = 总链尾：链收集完后再夹取
  for (const c of state.spawnChains)
    if (c.end === Infinity) c.end = state.timelineEnd;
  collectAudioEvents(state);
}

/** 全时间线音频事件收集：span 相对锚点 → 全局绝对；forever 链按循环圈数展开 */
function collectAudioEvents(state: TimelineState): void {
  const push = (seg: CompiledSegment, spanStart: Ms, spanEnd: Ms): void => {
    for (const a of seg.audio) {
      const at = spanStart + a.atMs;
      if (at >= spanEnd) continue; // 锚点已收窗外（transition 短路等）不响
      state.audioEvents.push({ ...a, globalAtMs: at });
    }
  };
  const walkSpans = (spans: ChainSpan[]): void => {
    for (const span of spans) push(span.seg, span.start, span.end);
  };
  for (const c of state.spawnChains) {
    if (c.killed) continue;
    walkSpans(c.spans);
    const last = c.spans[c.spans.length - 1];
    const contentLen = last ? last.end - c.start : 0;
    if (contentLen > 0 && c.end - c.start > contentLen) {
      // forever 循环重放：音频事件按圈数平移展开（与画面回卷同相位）
      const loops = Math.ceil((c.end - c.start) / contentLen);
      for (let k = 1; k < loops; k++)
        for (const span of c.spans) {
          const at = span.start + k * contentLen;
          push(span.seg, at, span.end + k * contentLen);
        }
    }
  }
  walkSpans(state.spans);
}

/** 编译单段：先跑 setup（资产/解码只跑一次）再跑 body 捕获节点流（每次出现都跑——prev 依出现上下文，不能按 id 缓存） */
export function compileScene(
  state: TimelineState,
  scene: SceneInternal<unknown>,
  prev: unknown,
  inheritedFps?: number,
): CompiledSegment {
  const { width, height, fps, headless, canvas } = state.opts;
  if (scene.setup) {
    const setupEnv = makeSetupEnv(state, scene);
    const r = scene.setup(setupEnv);
    if (r instanceof Promise)
      throw makeRenderError(
        "spec_violation",
        scene.id,
        0,
        "setup 返回 Promise：确定性时间线不支持异步 setup（资产解码须在 render 前完成）",
      );
  }
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
  const { width, height, fps, headless, canvas, assets } = state.opts;
  const rec = new Recorder(width, height, fps, headless, canvas);
  const hooks = {
    load: (url: string) => {
      if (!assets)
        throw makeRenderError(
          "spec_violation",
          scene.id,
          0,
          "assets.load：引擎未装配 AssetSource（组合根缺省应注入 fail-fast 实现）",
        );
      return assets.load(url);
    },
  };
  void scene;
  return Object.assign(rec, { assets: hooks });
}

/** 展开 spawn 链（编译期锚定的）；depth 帽 3（嵌套 spawn）。链登记由 buildChain 内完成，此处不再返回 */
export function expandSpawns(
  state: TimelineState,
  seg: CompiledSegment,
  spanStart: Ms,
  depth: number,
): void {
  if (depth > 3) return;
  for (const s of seg.spawns) {
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
      expandSpawns(state, sp.seg, sp.start, depth + 1);
  }
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
    const seg = compileScene(state, sc, prev, chainFps);
    prev = seg.bodyResult;
    // 链长 = 实际内容：transition 短路段只计 activeEnd（与主链收窗同规则）
    const len = seg.activeEnd ?? seg.duration;
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
