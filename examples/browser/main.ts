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
import { start } from "@lingfan-video/core";
import { render } from "@lingfan-video/core";
import {
  OfflineAudioMixer,
  PacedPreviewExporter,
  WebAudioOutput,
  WebCodecsExporter,
} from "@lingfan-video/infra";
import { clip, gain, loop, pan, rate, warp } from "@lingfan-video/core";
import type {
  AudioHandle,
  AudioOutput,
  Ms,
  Scene,
  StepContext,
} from "@lingfan-video/contracts";
import { makeSynthDecoder, makeSynthLoader } from "./audio-assets";

// ---------- 三幕剧本（fn 直接在 ctx.canvas 上 2d 绘制） ----------

function bg(ctx: StepContext): { shade: string } {
  const c = ctx.canvas as HTMLCanvasElement;
  const g = c.getContext("2d")!;
  const w = ctx.width;
  const h = ctx.height;
  g.fillStyle = "#101018";
  g.fillRect(0, 0, w, h);
  // 移动条纹背景：用 ctx.t 驱动（确定性：同一 t 同一画面）
  g.strokeStyle = "rgba(120,130,255,0.12)";
  g.lineWidth = 2;
  const offset = (ctx.t / 16) % 40;
  for (let x = -40 + offset; x < w + 40; x += 40) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x - h, h);
    g.stroke();
  }
  return { shade: "bg" };
}

function title(
  ctx: StepContext,
  text: string,
  sub?: string,
): { title: string } {
  const c = ctx.canvas as HTMLCanvasElement;
  const g = c.getContext("2d")!;
  const a = Math.min(1, ctx.progress * 3); // 淡入
  g.save();
  g.globalAlpha = a;
  g.fillStyle = "#e8e8ff";
  g.font = "600 42px 'Segoe UI', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, ctx.width / 2, ctx.height / 2 - (sub ? 18 : 0));
  if (sub) {
    g.fillStyle = "#7a7aff";
    g.font = "300 18px 'Segoe UI', sans-serif";
    g.fillText(sub, ctx.width / 2, ctx.height / 2 + 26);
  }
  g.restore();
  return { title: text };
}

const bgScene: Scene<unknown> = start(400, (env) => {
  env.step(400, (ctx) => {
    bg(ctx);
  });
});

const act1: Scene<{ title: string }> = start(1000, (env) => {
  // 登记期声明：与节点流同序，锚点 = 当前登记游标
  env.audio(clip("blip"), { at: 200, gain: gain(0.7, { fadeIn: 60 }) });
  env.step(1000, (ctx) => {
    bg(ctx);
    return title(ctx, "Code Video", "确定性视频引擎 · 声音走上下文");
  });
  return { title: "Code Video" };
});

const act2 = act1.cutTo(2000, (prev, env) => {
  env.spawn(bgScene, { key: "bg", forever: true }); // forever 链：背景跨段保活
  // 音频图：music 总线承载铺底与节拍，后面的 whoosh 走 fx 总线并侧链压低 music
  env.bus({ id: "music", gain: 0.9 });
  env.bgm(clip("pad"), { gain: gain(0.55, { fadeIn: 400 }), bus: "music" }); // 循环铺底
  // 节拍变速：0–600ms 提到 2 倍速（音高随之升高），1000ms 插回原速；
  // 循环铺满整幕——变速只改变「源空间取点速度」，不改变事件寿命。
  env.audio(clip("tick"), {
    gain: gain(0.3),
    bus: "music",
    loop: loop(),
    rate: warp([0, 0], [600, 1200], [1000, 1600]),
  });
  // 运行期音频：回调里现场发起（可拿到句柄做后续操作）
  let fired = 0;
  let left: AudioHandle | null = null;
  env.step(2000, (ctx) => {
    if (fired === 0 && ctx.localT >= 300) {
      fired = 1;
      left = ctx.audio(clip("blip"), { pan: pan(-0.8), gain: gain(0.6) });
      ctx.audio(clip("blip"), { pan: pan(0.8), gain: gain(0.6) });
    } else if (left && ctx.localT >= 1200) {
      // 句柄操作面：现场压低音量并提速，演示「引擎不因幕边界杀声音，只按指令改」
      left.setGain(0.15, 200);
      left.setRate(1.4, 200);
      left = null;
      // 总线参数也能逐帧改：铺底随「现场发起」一起收一点
      ctx.bus("music").gain(0.5);
    }
    return title(
      ctx,
      `${prev.title} :: 第二幕`,
      `t = ${ctx.t.toFixed(0)}ms · 铺底循环 + 现场发起 + 节拍变速`,
    );
  });
  return { title: `${prev.title} 完` };
});

const act3 = act2.cutTo(800, (prev, env) => {
  // 侧链：fx 出声时把 music 压 8dB（攻击/释放都是毫秒级，导出可复算）
  env.bus({ id: "fx" });
  // 程序化音源 + 延迟效果（echo 总线）——不依赖任何素材文件
  env.bus({
    id: "echo",
    effects: [{ kind: "delay", delayMs: 180, feedback: 0.35, mix: 0.5 }],
  });
  env.synth({
    wave: "triangle",
    freq: 660,
    durationMs: 320,
    gain: 0.18,
    bus: "echo",
  });
  env.duck({
    from: "fx",
    to: "music",
    amountDb: 8,
    attackMs: 5,
    holdMs: 60,
    releaseMs: 120,
  });
  env.audio(clip("whoosh"), {
    at: 0,
    bus: "fx",
    gain: gain(0.8, { fadeIn: 100 }),
  });
  // 自然退出：把 2s 铺底压缩到 800ms（warp 末锚点 "end"）→ 收在幕边界上
  env.audio(clip("pad"), {
    gain: gain(0.5, { fadeIn: 100, fadeOut: 200 }),
    rate: warp([0, 0], [800, "end"]),
  });
  let tail = false;
  env.step(800, (ctx) => {
    // 最后一个区函数里发起的声音也不会被丢：终界之前的窗口内照常发声
    if (!tail && ctx.progress > 0.9) {
      tail = true;
      ctx.audio(clip("blip"), { gain: gain(0.45, { fadeOut: 120 }) });
      // 运行期也能现场合成：振荡器 + 延迟总线
      ctx.synth({
        wave: "sine",
        freq: 880,
        durationMs: 140,
        gain: 0.12,
        bus: "echo",
      });
    }
    bg(ctx); // 整幅重绘（预览不逐帧清屏，未重绘的区域会留下上一帧）
    return title(ctx, "第三幕 · 收尾", `${prev.title} → 转场风声 + 加速收束`);
  });
});
void act3;

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
    playBtn.textContent = paused ? "▶ 继续" : "⏸ 暂停";
    if (audioCtx) void (paused ? audioCtx.suspend() : audioCtx.resume());
    return;
  }
  void play();
});

async function play(): Promise<void> {
  if (busy) return;
  busy = true;
  playBtn.disabled = true;
  exportBtn.disabled = true;
  playBtn.textContent = "渲染中…";
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
    playBtn.textContent = "▶ 重播";
  }
}

hud.textContent = "点「播放」开始（音频需用户手势解锁）";
playBtn.disabled = false;
playBtn.textContent = "▶ 播放";

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
      canvas: stage,
      exporter,
      audio,
      headless: false,
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
    exportBtn.textContent = "⬇ 导出 MP4";
  }
}
