import type {
  AudioProgram,
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  FrameSink,
  FrameState,
  FrameSource,
  Ms,
  Painter,
} from "@lingfan-video/contracts";
import { StateAggregator } from "../../domain/simulation";
import type { SceneEntry } from "../../domain/simulation/types";
import { buildAudioGraph, flushBusUpdates } from "./audio-graph";
import { buildAudioProgram } from "./audio-program";
import { makeRenderError } from "./error";
import { evaluateFrame } from "./frame-eval";
import { EMPTY_INPUT, createInputTrack } from "./input";
import { createProgramRandom } from "./random";
import { flushPendingSpawns } from "./runtime-spawn";
import { buildSampleGrid, firstAfter } from "./sample-grid";
import { buildTimeline } from "./timeline-build";
import type { EvalDeps, RunSummary, TimelineState } from "./engine-types";

/** 引擎可变状态装配（TimelineEngine 独占持有，原子单元经 EvalDeps 显式共享） */
function makeState(opts: EvalDeps["state"]["opts"]): TimelineState {
  return {
    opts,
    deadUnits: new Set<string>(),
    dyingUnits: new Map(),
    spawnChains: [],
    audioVoices: [],
    voiceSeq: 0,
    onceKeys: new Set<string>(),
    busSpecs: new Map(),
    sends: new Map(),
    ducks: new Map(),
    busParams: new Map(),
    busRamps: new Map(),
    busPoints: new Map(),
    busKill: new Map(),
    busAutomation: new Map(),
    selfPaced: new Map(),
    spans: [],
    pendingSpawns: [],
    timelineEpoch: 0,
    timelineEnd: 0,
    nowMs: 0,
    inCallback: false,
    input: createInputTrack(opts.input),
    nowInput: EMPTY_INPUT,
    random: createProgramRandom(opts.seed),
    randomStreams: new Map(),
    setupDone: new WeakSet(),
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
  private painter: Painter | null = null;

  constructor(opts: TimelineState["opts"]) {
    this.state = makeState(opts);
  }

  /** 注入同步帧来源（2D 回读 / 自绘 / 设备句柄；未装配 → spec_violation） */
  setPainter(p: FrameSource): void {
    this.painter = p;
  }

  /**
   * 注入帧来源：纯函数来源（同步或返回 Promise）或带生命周期的宿主。
   * 宿主在每次推演开始时收到 `begin`（重播即重置），结束时收到 `close`。
   */
  setFrameSource(source: Painter): void {
    this.painter = source;
  }

  private host(): FrameHost | null {
    const p = this.painter;
    return p !== null && typeof p !== "function" ? p : null;
  }

  private hostInfo(): FrameHostInfo {
    const opts = this.state.opts;
    return {
      fps: opts.fps,
      width: opts.width,
      height: opts.height,
      durationMs: this.state.timelineEnd,
      headless: opts.headless ?? false,
    };
  }

  /** 正片渲染：沿采样网格逐点求值并交帧；运行期 spawn 新增链 → 重建剩余网格（动态流式采样） */
  async run(
    head: SceneEntry,
    sink: FrameSink,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RunSummary> {
    await this.buildTimeline(head);
    // 预览端：时间线建好即锚定起点并预排登记期声音；运行期发射由 ctx.audio 即时发声
    await this.state.opts.audioOut?.begin(buildAudioProgram(this.state));
    // 有状态宿主：每次推演重新建场（重播不得沿用上一次的物理/时钟状态）。
    // begin 失败即整个推演失败，不交任何帧，也不调 close（宿主没开过）。
    const host = this.host();
    if (host) await host.begin(this.hostInfo());
    let summary: RunSummary | null = null;
    let failure: unknown = null;
    try {
      summary = await this.renderGrid(sink, onProgress);
    } catch (err) {
      failure = err;
    } finally {
      if (host?.close) {
        try {
          await host.close();
        } catch (closeErr) {
          // close 失败不得掩盖推演失败：两个错误都留给调用方
          failure =
            failure === null
              ? closeErr
              : new AggregateError(
                  [failure, closeErr],
                  "帧宿主 close 失败，且本次推演已经失败",
                );
        }
      }
    }
    if (failure !== null) throw failure;
    return summary!;
  }

  /**
   * 只编译不推演：时间线登记完成即返回 `run` 会交给 `AudioOutput.begin` 的同一份程序。
   *
   * 不渲染任何帧、不碰输出设备——用途是让预览端在页面加载时预热整条配乐的 PCM
   * （见 `WebAudioOutput.warm`）。程序与随后 `run` 得到的逐项相同：两者走同一条
   * 登记/编译路径，只是 `run` 还会在其后继续逐帧推演。
   */
  async compileAudioProgram(head: SceneEntry): Promise<AudioProgram> {
    await this.buildTimeline(head);
    return buildAudioProgram(this.state);
  }

  /** 逐点求值 + 交帧主循环（打帧源生命周期与错误收口都由 run 负责） */
  private async renderGrid(
    sink: FrameSink,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RunSummary> {
    let grid = buildSampleGrid(this.state);
    let idx = 0;
    let epoch = this.state.timelineEpoch;
    let written = 0;
    while (idx < grid.length) {
      const t = grid[idx]!; // 网格点已是毫秒
      this.evaluateFrame(written, t);
      this.syncBusParams(t);
      const carrier = await this.painterPaint(
        written,
        t,
        this.aggregator.snapshot(),
      );
      await sink.writeFrame(carrier, written, t);
      // 所有权已随交帧转移：引擎是本帧载体的最后一站，设备资源在这里归还
      if (carrier.kind === "handle") carrier.close();
      written++;
      onProgress?.(written, grid.length);
      idx++;
      // 运行期 spawn 的异步 setup：这一帧已交出，帧边界补完链（不阻塞帧内）
      if (this.state.pendingSpawns.length > 0)
        await flushPendingSpawns(this.state, (at) => firstAfter(grid, at));
      // 运行期 spawn（ctx.spawn/scheduler）追加或物化链 → 重采样（严格晚于当前点）
      if (this.state.timelineEpoch !== epoch) {
        epoch = this.state.timelineEpoch;
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
      audioGraph: buildAudioGraph(this.state, "timeline"),
    };
  }

  /** computeRange：采样网格 ∩ [from,to) 逐点采样完整状态表（同一次登记复用；动态链同样重采样） */
  async collect(head: SceneEntry, from: Ms, to: Ms): Promise<FrameState[]> {
    await this.buildTimeline(head);
    let grid = buildSampleGrid(this.state).filter(
      (t) => t >= from && t < to && t < this.state.timelineEnd,
    );
    let idx = 0;
    let epoch = this.state.timelineEpoch;
    const out: FrameState[] = [];
    while (idx < grid.length) {
      const t = grid[idx]!; // 网格点已是毫秒
      this.evaluateFrame(out.length, t);
      out.push(this.aggregator.full());
      idx++;
      if (this.state.pendingSpawns.length > 0)
        await flushPendingSpawns(this.state, (at) => firstAfter(grid, at));
      if (this.state.timelineEpoch !== epoch) {
        epoch = this.state.timelineEpoch;
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
    await this.buildTimeline(head);
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

  private async buildTimeline(head: SceneEntry): Promise<void> {
    await buildTimeline(this.deps().state, head);
  }

  private evaluateFrame(f: FrameIndex, t: Ms): void {
    evaluateFrame(this.deps(), f, t);
  }

  /** 预览端：把逐帧总线参数同步给实时音频图（无 setBus 的实现忽略） */
  private syncBusParams(t: Ms): void {
    const out = this.state.opts.audioOut;
    if (!out?.setBus) return;
    for (const u of flushBusUpdates(this.state, t)) out.setBus(u);
  }

  private deps(): EvalDeps {
    return {
      state: this.state,
      aggregator: this.aggregator,
      painterPaint: this.painterPaint.bind(this),
    };
  }

  private async painterPaint(
    f: FrameIndex,
    t: Ms,
    _state: FrameState,
  ): Promise<FrameCarrier> {
    const painter = this.painter;
    if (!painter)
      throw makeRenderError(
        "spec_violation",
        "engine",
        t,
        "未装配 Painter（infra/capture）",
      );
    // 纯函数来源没有生命周期：逐帧直接取；宿主则走 begin/frame/close
    if (typeof painter === "function") return await painter(f, t);
    return await painter.frame(f, t);
  }
}
