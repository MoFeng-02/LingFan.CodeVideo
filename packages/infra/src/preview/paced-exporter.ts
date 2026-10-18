/**
 * 预览节拍导出器（AudioOutput 之外的另一个消费端适配器）：不编码，只把每帧按时间戳放给看得见的地方（画布已由 step 直接绘制），
 * 用**时钟**把「帧时间戳 → 真实时间」对上。
 *
 * 为什么需要外部时钟：预览里画面与声音是两条消费链——画面按帧推进，声音排到 AudioContext 上。
 * 若画面跟墙钟、声音跟音频时钟，两条链的起点会错开：首次创建 AudioContext 时其 currentTime 可能
 * 冻结数百毫秒到数秒（音频设备冷启动），声音会排到很久以后才响，于是出现「视频放完了声音还在放」。
 * 以音频时钟为唯一主时钟后，画面等声音就绪再推进，两者自然同步；墙钟只在没有音频时钟时兜底。
 */
import type {
  ExportFormat,
  ExportResult,
  Exporter,
  ExporterImpl,
  FrameCarrier,
  Ms,
} from "@lingfan-video/contracts";

export interface PacedPreviewOptions {
  /** 主时钟（毫秒，单调不减）：通常传音频时钟；缺省用墙钟 */
  clock?: () => Ms;
  /** 暂停判定：为真时画面挂起（音频侧由宿主 suspend 上下文，时钟自停） */
  paused?: () => boolean;
  /** 主时钟多久不前进就判定失效并退回墙钟（毫秒，缺省 2000） */
  stallFallbackMs?: Ms;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** 预览导出器：按主时钟放帧（变帧率下按绝对时间戳播放，不累计误差） */
export class PacedPreviewExporter implements Exporter {
  readonly impl: ExporterImpl = "frames";
  readonly format: ExportFormat = "frames";
  private frames = 0;
  private lastMs = 0;
  private anchor: Ms | null = null;
  private wallFallback = false;
  private wallBase = 0;
  private readonly stallFallbackMs: Ms;

  constructor(private readonly opts: PacedPreviewOptions = {}) {
    this.stallFallbackMs = opts.stallFallbackMs ?? 2000;
  }

  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    void frame; // 载体不参与显示（可见画面来自 step 在宿主画布上的直接绘制）
    if (this.anchor === null) {
      this.wallBase = performance.now();
      // 时钟零点是「时间线 0」：音频时钟在 begin 锚点前可能为负（预排提前量），
      // 把它钳到 0 → 首帧等声音真正就位再显示，画面不会抢先一点点。
      this.anchor = Math.max(0, this.now() - timestampMs);
    }
    await this.waitUntil(this.anchor + timestampMs);
    this.frames++;
    this.lastMs = timestampMs;
  }

  async finalize(): Promise<ExportResult> {
    return {
      output: "(preview)",
      frames: this.frames,
      durationMs: this.lastMs,
      format: "frames",
    };
  }

  /** 重播前复位（帧数、锚点、墙钟兜底状态） */
  reset(): void {
    this.frames = 0;
    this.lastMs = 0;
    this.anchor = null;
    this.wallFallback = false;
    this.wallBase = 0;
  }

  /** 主时钟当前值（毫秒）；墙钟兜底或未接外部时钟时取 performance.now 相对量 */
  private now(): Ms {
    if (this.wallFallback || !this.opts.clock)
      return performance.now() - this.wallBase;
    return this.opts.clock();
  }

  /** 等到主时钟到达目标值；外部时钟长时间不前进则退回墙钟，保证预览不会永久卡死 */
  private async waitUntil(target: Ms): Promise<void> {
    let lastClock = this.now();
    let lastWall = performance.now();
    for (;;) {
      if (this.opts.paused?.()) {
        const wallAtPause = performance.now();
        while (this.opts.paused()) await sleep(80);
        // 外部时钟（音频暂停时 AudioContext 也 suspend，时钟自停）无需补偿；墙钟要扣掉暂停时长
        if (this.wallFallback || !this.opts.clock)
          this.wallBase += performance.now() - wallAtPause;
        lastClock = this.now();
        lastWall = performance.now();
      }
      const remain = target - this.now();
      if (remain <= 0) return;
      if (
        !this.wallFallback &&
        this.opts.clock &&
        performance.now() - lastWall > this.stallFallbackMs &&
        this.now() <= lastClock
      ) {
        // 时钟失效（音频设备未启动/被系统挂起）：退回墙钟，把当前帧对齐到「现在」
        this.wallFallback = true;
        this.wallBase = performance.now() - target;
        return;
      }
      await sleep(Math.min(remain, 32));
    }
  }
}
