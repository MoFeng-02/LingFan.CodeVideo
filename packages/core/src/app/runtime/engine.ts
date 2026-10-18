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
import { createProgramRandom, programSeed } from "./random";
import { flushPendingSpawns } from "./runtime-spawn";
import { buildSampleGrid, firstAfter } from "./sample-grid";
import { buildTimeline } from "./timeline-build";
import type { EvalDeps, RunSummary, TimelineState } from "./engine-types";

/** 引擎可变状态装配（TimelineEngine 独占持有，原子单元经 EvalDeps 显式共享） */
function makeState(opts: EvalDeps["state"]["opts"]): TimelineState {
  /** 整场随机种子：开工时归一化一次，重复推演复位根流时复用 */
  const randomSeed = programSeed(opts.seed);
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
    layers: new Map(),
    spans: [],
    pendingSpawns: [],
    timelineEpoch: 0,
    timelineEnd: 0,
    nowMs: 0,
    inCallback: false,
    input: createInputTrack(opts.input),
    nowInput: EMPTY_INPUT,
    random: createProgramRandom(randomSeed),
    randomSeed,
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

  /**
   * @param opts 推演配置：帧尺寸、基础采样密度、绘制目标与各注入面（见 {@link EngineOptions}）
   */
  constructor(opts: TimelineState["opts"]) {
    this.state = makeState(opts);
  }

  /**
   * 注入同步帧来源（2D 回读 / 自绘 / 设备句柄；未装配 → spec_violation）。
   *
   * @param p 逐帧取位图的纯函数来源：帧号（从 0 起）、时刻（毫秒）→ 帧载体
   */
  setPainter(p: FrameSource): void {
    this.painter = p;
  }

  /**
   * 注入帧来源：纯函数来源（同步或返回 Promise）或带生命周期的宿主。
   * 宿主在每次推演开始时收到 `begin`（重播即重置），结束时收到 `close`。
   *
   * @param source 帧来源：`FrameSource` 或 `FrameHost`（后者在 `run` 里走 begin/close）
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
    const declared = [...this.state.layers.values()];
    return {
      fps: opts.fps,
      width: opts.width,
      height: opts.height,
      durationMs: this.state.timelineEnd,
      headless: opts.headless ?? false,
      // 没有层声明时不给这个键：宿主的既有形态（旧实现只认 fps/尺寸/时长）不变
      ...(declared.length > 0 ? { layers: declared } : {}),
    };
  }

  /**
   * 正片渲染：沿采样网格逐点求值并交帧；运行期 spawn 新增链 → 重建剩余网格（动态流式采样）。
   *
   * 时序：先完整构建时间线（setup 与异步 I/O 都在这之前完成），再逐帧求值-交帧。
   * 有状态帧宿主先收到 `begin`，无论成败都在收尾时收到 `close`（close 失败不掩盖推演失败）。
   * 全过程不等待墙钟，帧时刻只来自采样网格，因此同剧本同配置可复现。
   *
   * @param head 主链头场景（`start` 返回的入口）
   * @param sink 帧出口：逐帧 `writeFrame(carrier, index, timestampMs)`，收尾 `finalize`
   * @param onProgress 每写完一帧回调（已写帧数 / 本次网格总点数）；总数会因运行期 spawn 重采样而变化
   * @returns {@link RunSummary}：帧数、时间线终界、终态与整条时间线的声音记录
   * @throws RenderError（kind = spec_violation / step_throw 等）或帧来源/宿主抛出的错误
   */
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
   *
   * @param head 主链头场景（与 `run` 传同一个）
   * @returns 与 `run` 交给 `AudioOutput.begin` 的同一份程序：总时长、声音记录、音频图
   */
  async compileAudioProgram(head: SceneEntry): Promise<AudioProgram> {
    await this.buildTimeline(head);
    return buildAudioProgram(this.state);
  }

  /**
   * 逐点求值 + 交帧主循环（打帧源生命周期与错误收口都由 run 负责）。
   *
   * 帧载体所有权随 `writeFrame` 转移：设备句柄类载体在交帧后由引擎 close。
   * 运行期 spawn 追加链或物化链后网格会重建，续跑严格晚于当前点，已交出的帧不重算。
   *
   * @param sink 帧出口
   * @param onProgress 每写完一帧回调（已写帧数 / 当前网格总点数）
   * @returns {@link RunSummary}
   */
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

  /**
   * computeRange：采样网格 ∩ [from,to) 逐点采样完整状态表（同一次登记复用；动态链同样重采样）。
   *
   * 只做模拟求值、不产位图；区间端点是时间线毫秒，`to` 不含。
   * 动态 spawn 重采样时续跑严格晚于当前点，已产出的状态不重算。
   *
   * @param head 主链头场景
   * @param from 区间起点（毫秒，含）
   * @param to 区间终点（毫秒，不含）
   * @returns 按时间升序的完整状态表（每点一份，含全部活跃键）
   */
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

  /**
   * computeAt：≤t 的最近采样点的完整状态表；越时间线尾 → undefined。
   *
   * 「最近」按网格点取（二分），因此返回的是某个真实采样时刻的状态，
   * 不是按 t 插值出来的中间态。
   *
   * @param head 主链头场景
   * @param t 查询时刻（毫秒）
   * @returns 该时刻之前（含）最近的网格点状态表；t 早于首个网格点或越过终界时 `undefined`
   */
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

  /**
   * 预览端：把逐帧总线参数同步给实时音频图（无 setBus 的实现忽略）。
   *
   * @param t 当前帧时刻（毫秒）；过渡时长由相邻两次下发的间隔推出
   */
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

  /**
   * 取一帧载体：纯函数来源逐帧直接取，宿主来源走 `frame` 且等待 Promise。
   *
   * @param f 帧号（从 0 起）
   * @param t 帧时刻（毫秒）
   * @param _state 本帧状态表（当前实现不向帧来源传递，保留给需要的后端）
   * @returns 帧载体（位图或设备句柄）
   * @throws RenderError（kind = spec_violation）未装配帧来源时
   */
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
