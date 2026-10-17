import type {
  FrameBitmap,
  FrameIndex,
  FrameSink,
  FrameState,
  Ms,
} from "@lingfan-video/contracts";
import { StateAggregator } from "../../domain/simulation";
import { msToFrames, timestampAt } from "../../domain/time-math/time-math";
import type { EvalDeps, TimelineState } from "./engine-types";
import type { SceneInternal } from "../../domain/simulation/types";
import { makeRenderError } from "./error";
import { evaluateFrame } from "./frame-eval";
import { buildTimeline } from "./timeline-build";

/** 引擎可变状态装配（TimelineEngine 独占持有，原子单元经 EvalDeps 显式共享） */
function makeState(opts: EvalDeps["state"]["opts"]): TimelineState {
  return {
    opts,
    deadUnits: new Set<string>(),
    spawnChains: [],
    form3: new Map(),
    spans: [],
    timelineEnd: 0,
  };
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

  /** 正片渲染：[0, timelineEnd) 逐帧求值并交帧 */
  async run(
    head: SceneInternal<unknown>,
    sink: FrameSink,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ frames: number; durationMs: Ms; lastState: FrameState }> {
    this.buildTimeline(head);
    const total = msToFrames(this.state.timelineEnd, this.state.opts.fps);
    for (let f: FrameIndex = 0; f < total; f++) {
      const t = timestampAt(f, this.state.opts.fps);
      this.evaluateFrame(f, t);
      await sink.writeFrame(
        this.painterPaint(f, t, this.aggregator.snapshot()),
        f,
      );
      onProgress?.(f + 1, total);
    }
    await sink.finalize();
    return {
      frames: total,
      durationMs: this.state.timelineEnd,
      lastState: this.aggregator.full(),
    };
  }

  /** computeRange：[from,to) 按 stepMs 步进采样完整状态表（同一次登记复用） */
  async collect(
    head: SceneInternal<unknown>,
    from: Ms,
    to: Ms,
    stepMs: Ms,
  ): Promise<FrameState[]> {
    this.buildTimeline(head);
    const out: FrameState[] = [];
    for (let t = from; t < to && t < this.state.timelineEnd; t += stepMs) {
      const f = Math.max(0, msToFrames(t, this.state.opts.fps));
      this.evaluateFrame(f, timestampAt(f, this.state.opts.fps));
      out.push(this.aggregator.full());
    }
    return out;
  }

  /** computeAt：t 所在帧（≤t 的最近帧）的完整状态表；越时间线尾 → undefined */
  async stateAt(
    head: SceneInternal<unknown>,
    t: Ms,
  ): Promise<FrameState | undefined> {
    this.buildTimeline(head);
    if (t >= this.state.timelineEnd) return undefined;
    const f = Math.max(0, msToFrames(t, this.state.opts.fps));
    this.evaluateFrame(f, timestampAt(f, this.state.opts.fps));
    return this.aggregator.full();
  }

  private buildTimeline(head: SceneInternal<unknown>): void {
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
