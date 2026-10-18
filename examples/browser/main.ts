/**
 * 浏览器实时预览示例：三幕剧本（与 examples/three-acts.ts 同构）+ 上下文音频。
 * 跑法：pnpm dev（Vite dev server，根 package.json scripts.dev）。
 *
 * 预览四件套：
 * 1. 用户 canvas 传入 RenderOptions —— step 回调的 ctx.canvas 就是它，2d 绘制直接可见；
 * 2. PacedPreviewExporter（infra）—— 以音频时钟为主时钟放帧，画面/声音同一起点同一速度；
 *    首次创建 AudioContext 时其时钟可能冷启动数秒，跟墙钟会「画面放完声音还在响」；
 * 3. WebAudioOutput —— 引擎边跑边发声音（登记期声明的 + 回调里 ctx.audio 现场发起的），
 *    预览端只负责排到 AudioContext 上；
 * 4. 引擎照旧确定性采样（变帧率网格），预览只是消费端，不改时间线语义。
 */
import { render } from "@lingfan-video/core";
import {
  OfflineAudioMixer,
  PacedPreviewExporter,
  WebAudioOutput,
  WebCodecsExporter,
} from "@lingfan-video/infra";
import type { AudioOutput, Ms } from "@lingfan-video/contracts";
import { makeSynthDecoder, makeSynthLoader } from "./audio-assets";
import { INPUT_EVENTS } from "./input-overlay";

import { act1 } from "./program";

// ---------- 播放控制 ----------

const stage = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const exportBtn = document.getElementById("export") as HTMLButtonElement;
let paused = false;
let busy = false;

/** 预览输出计数包装：统计引擎发起了多少声音（诊断用），并转发音频主时钟 */
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

  /** 音频主时钟（时间线毫秒）：画面排帧跟随它，画面与声音同一起点/同一速度 */
  nowMs(): Ms {
    return this.inner.nowMs();
  }
}

let audioCtx: AudioContext | null = null;
let output: CountingOutput | null = null;
/** 预览节拍器：以音频时钟为唯一主时钟排帧；无音频时退回墙钟（首次冷启动也不会音画错位） */
const sink = new PacedPreviewExporter({
  clock: () => output?.nowMs() ?? performance.now(),
  paused: () => paused,
});

function ensureAudio(): { ctx: AudioContext; out: CountingOutput } {
  if (audioCtx && output) return { ctx: audioCtx, out: output };
  audioCtx = new AudioContext();
  output = new CountingOutput(
    new WebAudioOutput(audioCtx, makeSynthLoader(audioCtx)),
  );
  return { ctx: audioCtx, out: output };
}

playBtn.addEventListener("click", () => {
  if (busy) {
    // 播放中：暂停/继续（画面靠预览 Exporter 挂起，音频靠上下文挂起）
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
  // 播放中播放键保持可点：暂停/继续由上面的 busy 分支接管（禁用会让该分支永远收不到点击）
  exportBtn.disabled = true;
  playBtn.textContent = "暂停";
  paused = false;
  sink.reset();
  const { ctx, out } = ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();
  out.dispose();
  out.voiced = 0;
  // 首次创建 AudioContext 时音频时钟可能冷启动数秒：首帧会等它就位（画面不抢先）
  hud.textContent = "准备音频时钟…";
  try {
    const result = await render(act1, {
      fps: 30,
      width: stage.width,
      height: stage.height,
      canvas: stage,
      exporter: sink,
      audioOutput: out,
      headless: false,
      input: INPUT_EVENTS,
      // 预览端画面就是这块 canvas（实时可见），不需要逐帧回读；导出模式缺省会回读。
      // 显式声明「本模式不需要像素」：否则缺省要求有 painter/2D 画布，缺失会直接 spec_violation。
      frames: "allow-blank",
      onProgress: (done, total) => {
        hud.textContent = `帧 ${done}/${total} · 声音 ${out.voiced}`;
      },
    });
    hud.textContent = `完成：${result.frames} 帧 / ${result.durationMs}ms · 声音 ${out.voiced}（登记期+运行期/循环/声像/变速/句柄）· 可重播`;
  } finally {
    busy = false;
    playBtn.disabled = false;
    exportBtn.disabled = false;
    playBtn.textContent = "重播";
  }
}

hud.textContent = "点「播放」开始（音频需用户手势解锁）";
playBtn.disabled = false;
playBtn.textContent = "播放";

// ---------- 导出（mp4 = H.264 视频 + AAC 音轨） ----------

exportBtn.addEventListener("click", () => void exportMp4());

/**
 * 导出 mp4：与预览同一份剧本、同一批合成音源，差异只在消费端——
 * 预览用 PacedPreviewExporter + WebAudioOutput 实时放；导出用 WebCodecsExporter（H.264 + AAC → mp4）
 * 与 OfflineAudioMixer（离线混出整条音轨，不依赖 AudioContext / 用户手势）。
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
    // 导出用一块独立的画布：预览画布上留着上一次播放的最后一帧与 2D 状态，
    // 复用会让「先预览再导出」与「直接导出」得到不同像素（同一剧本必须同一段推演）。
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = stage.width;
    exportCanvas.height = stage.height;
    const exporter = new WebCodecsExporter({
      width: stage.width,
      height: stage.height,
      fps: 30,
    });
    // 音频：离线混音 → 交错 Float32 → AAC；样本公式与预览完全相同
    const audio = new OfflineAudioMixer(makeSynthDecoder(48_000), {
      sampleRate: 48_000,
      channels: 2,
    });
    const result = await render(act1, {
      fps: 30,
      width: stage.width,
      height: stage.height,
      canvas: exportCanvas,
      exporter,
      audio,
      headless: false,
      input: INPUT_EVENTS,
      onProgress: (done, total) => {
        hud.textContent = `导出 ${done}/${total} 帧…`;
      },
    });
    const output = result.output;
    if (!output) throw new Error("导出未返回结果（exporter 未 finalize）");
    const blob = output.output;
    if (!(blob instanceof Blob)) throw new Error("导出器未返回 Blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "code-video.mp4";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    hud.textContent =
      `导出完成：${result.frames} 帧 / ${result.durationMs}ms · ` +
      `${(blob.size / 1024).toFixed(0)} KB · 已开始下载`;
  } catch (err) {
    hud.textContent = `导出失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy = false;
    playBtn.disabled = false;
    exportBtn.disabled = false;
    exportBtn.textContent = "导出 MP4";
  }
}
