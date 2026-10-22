/**
 * 预览与定格：同一个宿主，两种消费端。
 *
 * - 预览：合成结果贴回舞台（`CanvasBlitExporter`），放帧跟音频时钟；
 * - 定格：只渲染到 `?t=<ms>` 那一帧（核帧用，不出声）。
 */
import { compileAudioProgram, render } from "@lingfan-video/core";
import {
  CanvasBlitExporter,
  PacedPreviewExporter,
  WebAudioOutput,
} from "@lingfan-video/infra";
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

import { makeSynthLoader } from "./audio-assets";
import { makeStageHost } from "./host";
import { picture } from "./ledger/program";
import {
  BASE_FPS,
  HEIGHT,
  PREVIEW_H,
  PREVIEW_W,
  WIDTH,
  exportBtn,
  hud,
  paintIdleHud,
  playBtn,
  session,
  stage,
  warm,
} from "./session";

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
  paused: () => session.paused,
});

function ensureAudio(): { ctx: AudioContext; out: CountingOutput } {
  if (audioCtx && output) return { ctx: audioCtx, out: output };
  audioCtx = new AudioContext();
  output = new CountingOutput(
    new WebAudioOutput(audioCtx, makeSynthLoader(audioCtx)),
  );
  return { ctx: audioCtx, out: output };
}

/** 让出一帧：预热分片的让点。 */
const yieldFrame = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

// 音频预热：用户点播放前就把两件最贵的事做完——
// ① AudioWorklet 模块取回并编译；② 整条音轨的 PCM 现算好进缓存。
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
    if (!session.busy) paintIdleHud();
    // 观众已经点了播放就不要再让了：让点是为空闲期服务的。
    if (!warm.urgent) await yieldFrame();
  }
})();

/** 播放/暂停切换：播放中再点一次就是挂起，音频与画面一起停。 */
export function togglePlay(): void {
  if (session.busy) {
    session.paused = !session.paused;
    playBtn.textContent = session.paused ? "继续" : "暂停";
    if (audioCtx) {
      void (session.paused ? audioCtx.suspend() : audioCtx.resume());
    }
    return;
  }
  void play();
}

async function play(): Promise<void> {
  if (session.busy) return;
  session.busy = true;
  exportBtn.disabled = true;
  playBtn.textContent = "暂停";
  session.paused = false;
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
  // 底图必须是一块**看不见**的画布：若直接画在舞台上，下一帧的合成会把
  // "上一帧的最终画面"当底图再叠一遍，屏幕上就是拖影。合成结果再贴回舞台。
  const base = document.createElement("canvas");
  base.width = PREVIEW_W;
  base.height = PREVIEW_H;
  // 预览只给 CPU 档：GPU 档每帧要把三块画布当纹理重传，主线程跟不上实时节奏。
  const { host, program } = makeStageHost(base, PREVIEW_W, PREVIEW_H);
  try {
    const result = await render(program.picture, {
      fps: BASE_FPS,
      width: PREVIEW_W,
      height: PREVIEW_H,
      canvas: base,
      exporter: new CanvasBlitExporter(sink, stage),
      audioOutput: out,
      headless: false,
      painter: host,
      frames: "allow-blank",
      onProgress: (done) => {
        clearTimeout(slowHint);
        hud.textContent = `帧 ${done} · 声音 ${out.voiced}`;
      },
    });
    hud.textContent =
      `完成：${result.frames} 帧 · 声音 ${out.voiced}` + ` · 可重播`;
  } finally {
    clearTimeout(slowHint);
    session.busy = false;
    playBtn.disabled = false;
    exportBtn.disabled = false;
    playBtn.textContent = "重播";
  }
}

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

/** 定格到 `at` 毫秒：只把命中的那一帧贴到舞台上。 */
export async function runStill(at: Ms): Promise<void> {
  session.busy = true;
  playBtn.disabled = true;
  exportBtn.disabled = true;
  hud.textContent = `定格 ${at}ms…`;
  const still = new StillFrame(at);
  const base = document.createElement("canvas");
  base.width = PREVIEW_W;
  base.height = PREVIEW_H;
  // 定格与预览同一档：同一张画、同一批层，只是提前中断
  const { host, program } = makeStageHost(base, PREVIEW_W, PREVIEW_H);
  try {
    await render(program.picture, {
      fps: BASE_FPS,
      width: PREVIEW_W,
      height: PREVIEW_H,
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
