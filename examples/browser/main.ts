/**
 * 浏览器预览与导出：同一份剧本（`mv/program.ts` 的 `picture`）的三个消费端。
 *
 * 这支片子是**多后端**的：一块 WebGL 画布画三维，一块 2D 画布画字，
 * 由一个"合成宿主"按 z 叠成一张画面。三条消费端共用同一套宿主配置：
 * - 预览：合成结果贴回舞台（`CanvasBlitExporter`），放帧跟音频时钟；
 * - 定格：只渲染到 `?t=<ms>` 那一帧（核帧用，不出声）；
 * - 导出：合成结果是设备侧句柄，`new VideoFrame(画布)` 直接进编码器（零拷贝）。
 *
 * 合成器是可选的：缺省 GPU（three 四边形），失败自动退回 CPU（`drawImage`）。
 */
import { compileAudioProgram, render } from "@lingfan-video/core";
import {
  CanvasBlitExporter,
  OfflineAudioMixer,
  PacedPreviewExporter,
  WebAudioOutput,
  WebCodecsExporter,
  createCanvas2dCompositor,
  createCompositeHost,
} from "@lingfan-video/infra";
import { createThreeCompositor } from "@lingfan-video/infra/frames/adapters/three-compositor";

import type {
  AudioOutput,
  AudioProgram,
  ExportFormat,
  ExportResult,
  Exporter,
  ExporterImpl,
  FrameCarrier,
  Ms,
} from "@lingfan-video/contracts";
import { makeSynthDecoder, makeSynthLoader } from "./audio-assets";
import { makeSongDecoder, makeSongLoader } from "./song-audio";
import { createLayer2d } from "./mv/layer2d";
import { picture } from "./program";
import { createStage3d } from "./mv/stage3d";
import { TOTAL } from "./mv/timeline";

/** 输出尺寸与基准采样率（剧本内的 640×360 设计空间按 2 倍放大）。 */
const WIDTH = 1280;
const HEIGHT = 720;
const BASE_FPS = 30;

const stage = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const exportBtn = document.getElementById("export") as HTMLButtonElement;
let paused = false;
let busy = false;

/** 预览输出计数包装：统计引擎发起了多少声音（诊断用），并转发音频主时钟。 */
class CountingOutput implements AudioOutput {
  voiced = 0;

  constructor(private readonly inner: WebAudioOutput) {}

  begin(program: Parameters<AudioOutput["begin"]>[0]): Promise<void> {
    this.voiced += program.voices.length;
    return this.inner.begin(program);
  }

  start(voice: Parameters<AudioOutput["start"]>[0]) {
    this.voiced += 1;
    return this.inner.start(voice);
  }

  dispose(): void {
    this.inner.dispose();
  }

  /** 预热转发：页面加载时先把 worklet 模块取回编译好（不计数，它不出声） */
  prepare(): Promise<void> {
    return this.inner.prepare();
  }

  /** 预合成转发：把整条音轨的 PCM 提前算好并缓存（同样不出声、不计数）。 */
  warm(program: Parameters<WebAudioOutput["warm"]>[0]): Promise<void> {
    return this.inner.warm(program);
  }

  /** 音频主时钟（时间线毫秒）：画面排帧跟随它，画面与声音同一起点、同一速度。 */
  nowMs(): Ms {
    return this.inner.nowMs();
  }
}

let audioCtx: AudioContext | null = null;
let output: CountingOutput | null = null;
/** 预览节拍器：以音频时钟为唯一主时钟排帧；无音频时退回墙钟。 */
const sink = new PacedPreviewExporter({
  clock: () => output?.nowMs() ?? performance.now(),
  paused: () => paused,
});

function ensureAudio(): { ctx: AudioContext; out: CountingOutput } {
  if (audioCtx && output) return { ctx: audioCtx, out: output };
  audioCtx = new AudioContext();
  output = new CountingOutput(
    new WebAudioOutput(
      audioCtx,
      makeSongLoader(audioCtx, makeSynthLoader(audioCtx)),
    ),
  );
  return { ctx: audioCtx, out: output };
}

/**
 * 片场：底图 + 两个后端层的合成宿主。
 *
 * 三条消费端共用这一份配置——底图是引擎画的那块 2D 画布（这支片子里它保持空白，
 * 字与三维都在层里），叠层是「三维（z 0）+ 文字（z 20）」。
 *
 * 合成器有两档，**预览与导出各选一档**，理由是实测的代价不同：
 * - 预览要跟着音频时钟实时放，帧率就是观众的观感。GPU 合成（three 四边形）每帧要把
 *   三块 1280×720 画布当纹理重传（`preserveDrawingBuffer` 还要回读），实测把主线程压死；
 *   而浏览器的 2D `drawImage` 本身就走 GPU，叠三块画布几乎不要钱——所以预览用 CPU 档。
 * - 导出只要吞吐，且希望「合成结果直接进编码器」，所以用 GPU 档：合成画布零拷贝进
 *   `VideoFrame`，一次像素回读都不做。
 * 两档叠出来的画面是同一张（同一批层、同一个 z 序），差别只在谁叠。
 */
function makeHost(canvas: HTMLCanvasElement, gpu: boolean) {
  return createCompositeHost({
    base: canvas,
    width: WIDTH,
    height: HEIGHT,
    // 层声明在剧本里（env.layer），这里只提供每一层的渲染面——宿主不认识渲染器。
    surfaces: {
      stage3d: createStage3d(WIDTH, HEIGHT),
      type: createLayer2d(WIDTH, HEIGHT),
    },
    candidates: gpu
      ? [() => createThreeCompositor(), () => createCanvas2dCompositor()]
      : [() => createCanvas2dCompositor()],
  });
}

// 音频预热：用户点播放前就把两件最贵的事做完——
// ① AudioWorklet 模块取回并编译；② 歌与音效的 PCM 现算好进缓存。
// 少了这两步，首帧要等模块加载与素材解码，观众看到的是「点了没反应一两秒」。
const warm = { done: 0, total: 0, failed: false, urgent: false };

/** 让出一帧：预热分片的让点。 */
const yieldFrame = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const warmReady: Promise<void> = (async () => {
  await yieldFrame();
  const { out } = ensureAudio();
  try {
    await out.prepare();
  } catch {
    // worklet 加载失败不拦播放：begin 时会带着可读错误再试一次
  }
  let program: AudioProgram | null = null;
  try {
    program = await compileAudioProgram(picture, {
      fps: BASE_FPS,
      width: WIDTH,
      height: HEIGHT,
    });
  } catch {
    warm.failed = true;
    return;
  }
  warm.total = program.voices.length;
  for (const voice of program.voices) {
    try {
      await out.warm({ ...program, voices: [voice] });
    } catch {
      warm.failed = true;
    }
    warm.done += 1;
    if (!busy) paintIdleHud();
    // 观众已经点了播放就不要再让了：让点是为空闲期服务的。
    if (!warm.urgent) await yieldFrame();
  }
})();

/** 未播放时的 HUD：空闲问候 / 预热进度。 */
function paintIdleHud(): void {
  if (busy) return;
  if (warm.total === 0) {
    hud.textContent = "点「播放」开始（音频需用户手势解锁）";
    return;
  }
  hud.textContent =
    warm.done < warm.total
      ? `预热音轨 ${warm.done}/${warm.total} · 可以先点播放`
      : warm.failed
        ? "预热未完成，播放时会重试"
        : "就绪 · 点「播放」开始";
}

playBtn.addEventListener("click", () => {
  if (busy) {
    // 播放中：暂停/继续（画面靠预览 Exporter 挂起，音频靠上下文挂起）。
    paused = !paused;
    playBtn.textContent = paused ? "继续" : "暂停";
    if (audioCtx) void (paused ? audioCtx.suspend() : audioCtx.resume());
    return;
  }
  void play();
});

async function play(): Promise<void> {
  if (busy) return;
  busy = true;
  exportBtn.disabled = true;
  playBtn.textContent = "暂停";
  paused = false;
  sink.reset();
  hud.textContent = "准备音频时钟…";
  const slowHint = setTimeout(() => {
    hud.textContent = "准备音频…（首次要现算整条音轨，之后重播即时）";
  }, 400);
  const { ctx, out } = ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();
  out.dispose();
  out.voiced = 0;
  warm.urgent = true;
  await warmReady;
  // 引擎画的底图必须是一块**看不见**的画布：
  // 若直接画在舞台（观众看的那块）上，下一帧的合成会把"上一帧的最终画面"
  // 当成底图再叠一遍，屏幕上就是拖影。所以底图与显示分开，合成结果再贴回舞台。
  const base = document.createElement("canvas");
  base.width = WIDTH;
  base.height = HEIGHT;
  const host = makeHost(base, false);
  // 宿主生命周期归引擎（begin → frame… → close 都在推演里），示例只负责给它块画布。
  try {
    const result = await render(picture, {
      fps: BASE_FPS,
      width: WIDTH,
      height: HEIGHT,
      canvas: base,
      exporter: new CanvasBlitExporter(sink, stage),
      audioOutput: out,
      headless: false,
      painter: host,
      frames: "allow-blank",
      onProgress: (done, total) => {
        clearTimeout(slowHint);
        hud.textContent = `帧 ${done}/${total} · 声音 ${out.voiced}`;
      },
    });
    hud.textContent =
      `完成：${result.frames} 帧 / ${result.durationMs}ms · 声音 ${out.voiced}` +
      ` · 可重播`;
  } finally {
    clearTimeout(slowHint);
    busy = false;
    playBtn.disabled = false;
    exportBtn.disabled = false;
    playBtn.textContent = "重播";
  }
}

// ---------- 定格模式（调试用：?t=<毫秒>） ----------

/** 定格时用来中断渲染的信号。 */
class StillStop extends Error {}

/**
 * 只放到目标时刻就停的导出器：`writeFrame` 收到 ≥ 目标时间戳的第一帧时抛信号。
 * 此时该帧已经贴到舞台上，因此页面停住的正是目标时刻那一帧。
 */
class StillFrame implements Exporter {
  readonly impl: ExporterImpl = "frames";
  readonly format: ExportFormat = "frames";
  hit = false;
  frames = 0;
  lastMs: Ms = 0;

  constructor(private readonly at: Ms) {}

  async writeFrame(_frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    this.frames += 1;
    this.lastMs = timestampMs;
    if (timestampMs >= this.at) {
      this.hit = true;
      throw new StillStop();
    }
  }

  async finalize(): Promise<ExportResult> {
    return {
      output: "(still)",
      frames: this.frames,
      durationMs: this.lastMs,
      format: "frames",
    };
  }
}

async function runStill(at: Ms): Promise<void> {
  busy = true;
  playBtn.disabled = true;
  exportBtn.disabled = true;
  hud.textContent = `定格 ${at}ms…`;
  const still = new StillFrame(at);
  // 同样是"底图不可见"：定格只把命中的那一帧贴到舞台上。
  const base = document.createElement("canvas");
  base.width = WIDTH;
  base.height = HEIGHT;
  const host = makeHost(base, false);
  try {
    await render(picture, {
      fps: BASE_FPS,
      width: WIDTH,
      height: HEIGHT,
      canvas: base,
      exporter: new CanvasBlitExporter(still, stage),
      headless: false,
      painter: host,
      frames: "allow-blank",
    });
    hud.textContent = `定格 ${at}ms：全片已放完（最后一帧 ${still.lastMs}ms）`;
  } catch (err) {
    hud.textContent = still.hit
      ? `定格 ${still.lastMs}ms · 第 ${still.frames} 帧`
      : `定格失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

playBtn.disabled = false;
playBtn.textContent = "播放";
paintIdleHud();

const stillAt = Number(new URLSearchParams(location.search).get("t"));
if (Number.isFinite(stillAt) && stillAt > 0) void runStill(stillAt);

// ---------- 导出（mp4 = H.264 视频 + AAC 音轨） ----------

exportBtn.addEventListener("click", () => void exportMp4());

/**
 * 导出 mp4：与预览同一份剧本、同一批层、同一个合成宿主，差异只在消费端——
 * 预览贴回舞台实时放；导出把合成画布直接交给编码器，音频离线混。
 */
async function exportMp4(): Promise<void> {
  if (busy) return;
  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined"
  ) {
    hud.textContent = "当前浏览器不支持 WebCodecs 编码（需要 Chrome/Edge 94+）";
    return;
  }
  busy = true;
  playBtn.disabled = true;
  exportBtn.disabled = true;
  exportBtn.textContent = "导出中…";
  hud.textContent = "编码中…";
  try {
    // 导出用一块独立画布：预览画布上留着上一次播放的最后一帧与 2D 状态，
    // 复用会让「先预览再导出」与「直接导出」得到不同像素。
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = WIDTH;
    exportCanvas.height = HEIGHT;
    const host = makeHost(exportCanvas, true);
    const exporter = new WebCodecsExporter({
      width: WIDTH,
      height: HEIGHT,
      fps: BASE_FPS,
      // 两个多分钟、1280×720，默认 8Mbps 会把文件顶到 130MB 以上；
      // 画面以大面积暗部为主，7Mbps 足够。
      bitrate: 7_000_000,
    });
    const audio = new OfflineAudioMixer(
      makeSongDecoder(makeSynthDecoder(48_000)),
      {
        sampleRate: 48_000,
        channels: 2,
      },
    );
    const result = await render(picture, {
      fps: BASE_FPS,
      width: WIDTH,
      height: HEIGHT,
      canvas: exportCanvas,
      exporter,
      audio,
      headless: false,
      painter: host,
      onProgress: (done, total) => {
        hud.textContent = `导出 ${done}/${total} 帧…（合成后端 ${host.compositorId ?? "探测中"}）`;
      },
    });
    const output = result.output;
    if (!output) throw new Error("导出未返回结果（exporter 未 finalize）");
    const blob = output.output;
    if (!(blob instanceof Blob)) throw new Error("导出器未返回 Blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "deepseek-mv.mp4";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    hud.textContent =
      `导出完成：${result.frames} 帧 / ${result.durationMs}ms · ` +
      `${(blob.size / 1024 / 1024).toFixed(1)} MB · 已开始下载`;
  } catch (err) {
    hud.textContent = `导出失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy = false;
    playBtn.disabled = false;
    exportBtn.disabled = false;
    exportBtn.textContent = "导出 MP4";
  }
}

void TOTAL;
