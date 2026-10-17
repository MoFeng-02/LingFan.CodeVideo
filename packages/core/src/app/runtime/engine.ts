import type {
  FrameBitmap,
  FrameIndex,
  FrameSink,
  FrameState,
  Ms,
} from "@lingfan-video/contracts";
import { StateAggregator } from "../../domain/simulation";
import type { CompiledUnit, SceneEntry } from "../../domain/simulation/types";
import { makeRenderError } from "./error";
import { evaluateFrame } from "./frame-eval";
import { buildTimeline } from "./timeline-build";
import type {
  ChainSpan,
  EvalDeps,
  RunSummary,
  TimelineState,
} from "./engine-types";

/** 引擎可变状态装配（TimelineEngine 独占持有，原子单元经 EvalDeps 显式共享） */
function makeState(opts: EvalDeps["state"]["opts"]): TimelineState {
  return {
    opts,
    deadUnits: new Set<string>(),
    dyingUnits: new Map(),
    spawnChains: [],
    audioVoices: [],
    voiceSeq: 0,
    form3: new Map(),
    spans: [],
    timelineEnd: 0,
    nowMs: 0,
    inCallback: false,
  };
}

/**
 * 采样网格：各活跃单元在自己 fps 网格上的采样点并集。
 * - 单元 fps 网格：第 n 点 = windowStart + n×(1000/fps)，取整微秒去重
 * - hold 单元窗外冻结不加点（末点由窗口内网格覆盖）
 * - 空窗（无任何单元）不产帧——语义层单位是毫秒，fps 只是采样密度
 */
export function buildSampleGrid(state: TimelineState): Ms[] {
  const seen = new Set<number>(); // 微秒整数
  const points: number[] = [];
  const addUnit = (u: CompiledUnit, spanStart: Ms, spanEnd: Ms): void => {
    const s = spanStart + u.windowStart;
    const e = Math.min(spanStart + u.windowEnd, spanEnd);
    for (let i = 0; ; i++) {
      const tUs = Math.round((s + (i * 1000) / u.fps) * 1000);
      if (tUs >= Math.round(e * 1000) || tUs < Math.round(s * 1000)) break;
      if (!seen.has(tUs)) {
        seen.add(tUs);
        points.push(tUs);
      }
    }
  };

  const walkSpans = (spans: EvalDeps["state"]["spans"]): void => {
    for (const span of spans) {
      for (const u of span.seg.units) {
        // wait 回调单元不贡献采样点（B1：自身不产帧）
        if (u.onUpdate) continue;
        if (u.loop && u.loop.iterationMs === undefined) {
          // form-3：自管节奏——采样点沿基础帧率推进（自管单元没有固定网格）
          const s = span.start + u.windowStart;
          const e = Math.min(span.start + u.windowEnd, span.end);
          for (let tUs = Math.round(s * 1000); tUs < Math.round(e * 1000);) {
            if (!seen.has(tUs)) {
              seen.add(tUs);
              points.push(tUs);
            }
            tUs += Math.round(1_000_000 / state.opts.fps);
          }
        } else {
          addUnit(u, span.start, span.end);
        }
      }
    }
  };

  for (const c of state.spawnChains) {
    if (!c.killed) walkSpans(c.spans);
    // forever 链循环重放：内容播完后的尾段沿链网格（第一圈相位）补采样点
    if (!c.killed && c.end !== Infinity) {
      const contentLen = c.spans[c.spans.length - 1]!.end - c.start;
      if (contentLen > 0 && c.end - c.start > contentLen) {
        const loops = Math.ceil((c.end - c.start) / contentLen);
        const original = c.spans;
        for (let k = 1; k < loops; k++)
          for (const span of original) {
            const shifted: ChainSpan = {
              scene: span.scene,
              seg: span.seg,
              start: span.start + k * contentLen,
              end: span.end + k * contentLen,
            };
            for (const u of span.seg.units) {
              if (u.onUpdate) continue; // wait 回调单元不贡献采样点
              if (u.loop && u.loop.iterationMs === undefined) continue; // form-3 简化：循环圈内沿基础网格
              addUnit(u, shifted.start, shifted.end);
            }
          }
      }
    }
  }
  walkSpans(state.spans);
  points.sort((a, b) => a - b);
  return points.map((us) => us / 1000);
}

/**
 * 时间线引擎（app 层）：登记 → 编译 → 逐帧求值 → key 化聚合 → 交帧。
 * 确定性约定：帧时间戳 = 逐帧乘法禁累加；同帧绘制顺序 =
 * spawn 链在前、登记链在后；spawn 同 key 活跃 → 续接（返回既有链句柄）。
 * 时间语义：ctx.t=全局时间线时间、localT=单元窗内时间；Engine 实例单次渲染用。
 * 实现拆分：时间线构建 timeline-build / 逐帧求值 frame-eval / 运行期句柄 spawn-handle。
 */
export class TimelineEngine {
  private readonly state: TimelineState;
  private readonly aggregator = new StateAggregator();
  private painter:
    ((f: FrameIndex, t: Ms, state: FrameState) => FrameBitmap) | null = null;

  constructor(opts: TimelineState["opts"]) {
    this.state = makeState(opts);
  }

  /** 注入帧位图来源（infra/capture 组装；引擎不认平台 API，未装配 → spec_violation） */
  setPainter(p: (f: FrameIndex, t: Ms) => FrameBitmap): void {
    this.painter = p;
  }

  /** 正片渲染：沿采样网格逐点求值并交帧；运行期 spawn 新增链 → 重建剩余网格（动态流式采样） */
  async run(
    head: SceneEntry,
    sink: FrameSink,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RunSummary> {
    this.buildTimeline(head);
    // 预览端：时间线建好即锚定起点并预排登记期声音；运行期发射由 ctx.audio 即时发声
    await this.state.opts.audioOut?.begin({
      durationMs: this.state.timelineEnd,
      voices: this.state.audioVoices,
    });
    let grid = buildSampleGrid(this.state);
    let idx = 0;
    let chainCount = this.state.spawnChains.length;
    let written = 0;
    while (idx < grid.length) {
      const t = grid[idx]!; // 网格点已是毫秒
      this.evaluateFrame(written, t);
      await sink.writeFrame(
        this.painterPaint(written, t, this.aggregator.snapshot()),
        written,
        t,
      );
      written++;
      onProgress?.(written, grid.length);
      idx++;
      // 运行期 spawn（ctx.spawn/scheduler）在求值中追加链 → 重采样（严格晚于当前点）
      if (this.state.spawnChains.length !== chainCount) {
        chainCount = this.state.spawnChains.length;
        grid = buildSampleGrid(this.state);
        idx = grid.findIndex((u) => u > t);
        if (idx < 0) break;
      }
    }
    await sink.finalize();
    return {
      frames: written,
      durationMs: this.state.timelineEnd,
      lastState: this.aggregator.full(),
      audioVoices: this.state.audioVoices,
    };
  }

  /** computeRange：采样网格 ∩ [from,to) 逐点采样完整状态表（同一次登记复用；动态链同样重采样） */
  async collect(head: SceneEntry, from: Ms, to: Ms): Promise<FrameState[]> {
    this.buildTimeline(head);
    let grid = buildSampleGrid(this.state).filter(
      (t) => t >= from && t < to && t < this.state.timelineEnd,
    );
    let idx = 0;
    let chainCount = this.state.spawnChains.length;
    const out: FrameState[] = [];
    while (idx < grid.length) {
      const t = grid[idx]!; // 网格点已是毫秒
      this.evaluateFrame(out.length, t);
      out.push(this.aggregator.full());
      idx++;
      if (this.state.spawnChains.length !== chainCount) {
        chainCount = this.state.spawnChains.length;
        grid = buildSampleGrid(this.state).filter(
          (x) => x >= from && x < to && x < this.state.timelineEnd,
        );
        idx = grid.findIndex((x) => x > t); // 严格晚于当前点
        if (idx < 0) break;
      }
    }
    return out;
  }

  /** computeAt：≤t 的最近采样点的完整状态表；越时间线尾 → undefined */
  async stateAt(head: SceneEntry, t: Ms): Promise<FrameState | undefined> {
    this.buildTimeline(head);
    if (t >= this.state.timelineEnd) return undefined;
    const grid = buildSampleGrid(this.state);
    // ≤t 的最近网格点（二分）
    let lo = 0;
    let hi = grid.length - 1;
    let pick = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((grid[mid] ?? 0) <= t) {
        pick = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (pick < 0) return undefined;
    this.evaluateFrame(pick, grid[pick]!);
    return this.aggregator.full();
  }

  private buildTimeline(head: SceneEntry): void {
    buildTimeline(this.deps().state, head);
  }

  private evaluateFrame(f: FrameIndex, t: Ms): void {
    evaluateFrame(this.deps(), f, t);
  }

  private deps(): EvalDeps {
    return {
      state: this.state,
      aggregator: this.aggregator,
      painterPaint: this.painterPaint.bind(this),
    };
  }

  private painterPaint(f: FrameIndex, t: Ms, state: FrameState): FrameBitmap {
    if (!this.painter)
      throw makeRenderError(
        "spec_violation",
        "engine",
        t,
        "未装配 Painter（infra/capture）",
      );
    return this.painter(f, t, state);
  }
}
