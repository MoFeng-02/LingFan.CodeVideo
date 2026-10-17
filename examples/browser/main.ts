/**
 * 浏览器实时预览示例：三幕剧本（与 examples/three-acts.ts 同构）+ 上下文音频。
 * 跑法：pnpm dev（Vite dev server，根 package.json scripts.dev）。
 *
 * 预览四件套：
 * 1. 用户 canvas 传入 RenderOptions —— step 回调的 ctx.canvas 就是它，2d 绘制直接可见；
 * 2. PacedPreviewExporter —— 每帧对齐「时间戳 → 墙钟」推进，预览按真实时长播放；
 * 3. WebAudioOutput —— 引擎边跑边发声音（登记期声明的 + 回调里 ctx.audio 现场发起的），
 *    预览端只负责排到 AudioContext 上；
 * 4. 引擎照旧确定性采样（变帧率网格），预览只是消费端，不改时间线语义。
 */
import { start } from "@lingfan-video/core";
import { render } from "@lingfan-video/core";
import { WebAudioOutput } from "@lingfan-video/infra";
import { clip, gain, loop, pan, rate, warp } from "@lingfan-video/core";
import type {
  AudioHandle,
  AudioOutput,
  ExportFormat,
  ExportResult,
  Exporter,
  ExporterImpl,
  FrameBitmap,
  Ms,
  Scene,
  StepContext,
} from "@lingfan-video/contracts";
import { makeSynthLoader } from "./audio-assets";

/** 预览导出器：不编码（impl/format = frames），只把每帧按真实时间戳排队放出（变帧率下按绝对时间播放） */
class PacedPreviewExporter implements Exporter {
  readonly impl: ExporterImpl = "frames";
  readonly format: ExportFormat = "frames";
  private startWall = 0;
  private frames = 0;
  private lastMs = 0;

  constructor(
    private readonly target: HTMLCanvasElement,
    private readonly paused: () => boolean,
  ) {
    void this.target;
  }

  async writeFrame(frame: FrameBitmap, timestampMs: Ms): Promise<void> {
    void frame; // CPU 占位位图（全 0）：可见画面来自 fn 直接绘制，不叠加
    this.frames++;
    this.lastMs = timestampMs;
    if (this.startWall === 0) this.startWall = performance.now();
    // 暂停累计：恢复后不追帧
    if (this.paused()) {
      const p = performance.now();
      while (this.paused()) await new Promise((r) => setTimeout(r, 80));
      this.startWall += performance.now() - p;
    }
    const wait = this.startWall + timestampMs - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async finalize(): Promise<ExportResult> {
    return {
      output: "(preview)",
      frames: this.frames,
      durationMs: this.lastMs,
      format: "frames",
    };
  }

  reset(): void {
    this.startWall = 0;
    this.frames = 0;
    this.lastMs = 0;
  }
}

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
  env.bgm(clip("pad"), { gain: gain(0.55, { fadeIn: 400 }) }); // 循环铺底
  // 节拍变速：0–600ms 提到 2 倍速（音高随之升高），1000ms 插回原速；
  // 循环铺满整幕——变速只改变「源空间取点速度」，不改变事件寿命。
  env.audio(clip("tick"), {
    gain: gain(0.3),
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
  env.audio(clip("whoosh"), { at: 0, gain: gain(0.8, { fadeIn: 100 }) });
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
let paused = false;
let busy = false;

/** 预览输出计数包装：只统计引擎发起了多少声音（诊断信息用） */
class CountingOutput implements AudioOutput {
  voiced = 0;

  constructor(private readonly inner: AudioOutput) {}

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
}

const sink = new PacedPreviewExporter(stage, () => paused);
let audioCtx: AudioContext | null = null;
let output: CountingOutput | null = null;

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
    // 播放中：暂停/继续（画面靠 paced sink 挂起，音频靠上下文挂起）
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
  playBtn.textContent = "渲染中…";
  paused = false;
  sink.reset();
  const { ctx, out } = ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();
  out.dispose();
  out.voiced = 0;
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
      painter: () => ({
        data: new Uint8ClampedArray(stage.width * stage.height * 4),
        width: stage.width,
        height: stage.height,
      }),
      onProgress: (done, total) => {
        hud.textContent = `帧 ${done}/${total} · 声音 ${out.voiced}`;
      },
    });
    hud.textContent = `完成：${result.frames} 帧 / ${result.durationMs}ms · 声音 ${out.voiced}（登记期+运行期/循环/声像/变速/句柄）· 可重播`;
  } finally {
    busy = false;
    playBtn.disabled = false;
    playBtn.textContent = "▶ 重播";
  }
}

hud.textContent = "点「播放」开始（音频需用户手势解锁）";
playBtn.disabled = false;
playBtn.textContent = "▶ 播放";
