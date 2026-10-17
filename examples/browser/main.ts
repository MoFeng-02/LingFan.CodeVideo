/**
 * 浏览器实时预览示例：三幕剧本（与 examples/three-acts.ts 同构）+ 音频。
 * 跑法：pnpm dev（Vite dev server，根 package.json scripts.dev）。
 *
 * 预览四件套：
 * 1. 用户 canvas 传入 RenderOptions —— step 回调的 ctx.canvas 就是它，2d 绘制直接可见；
 * 2. PacedFrameSink —— 每帧对齐「时间戳 → 墙钟」推进，预览按真实时长播放；
 * 3. onAudioScript —— 时间线建好即拿到音频事件表，WebAudio 预排（多实例/循环/声道/摆位）；
 * 4. 引擎照旧确定性采样（变帧率网格），预览只是消费端，不改时间线语义。
 */
import { start } from "@lingfan-video/core";
import { render } from "@lingfan-video/core";
import { WebAudioPlayer } from "@lingfan-video/infra";
import type {
  AudioTimelineEvent,
  FrameBitmap,
  FrameIndex,
  FrameSink,
  Ms,
  Scene,
  StepContext,
} from "@lingfan-video/contracts";
import { makeSynthLoader } from "./audio-assets";

/** 按时间戳对齐墙钟的预览 sink（变帧率下网格非均匀：按真时间播放） */
class PacedFrameSink implements FrameSink {
  private startWall = 0;

  constructor(
    private readonly target: HTMLCanvasElement,
    private readonly paused: () => boolean,
  ) {
    void this.target;
  }

  async writeFrame(
    frame: FrameBitmap,
    _index: FrameIndex,
    timestampMs: Ms,
  ): Promise<void> {
    void frame; // CPU 占位位图（全 0）：可见画面来自 fn 直接绘制，不叠加
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

  async finalize(): Promise<void> {}
  reset(): void {
    this.startWall = 0;
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
  env.audio({ url: "blip" }, { at: 200, volume: 0.7, fadeIn: 60 });
  env.step(1000, (ctx) => {
    bg(ctx);
    return title(ctx, "Code Video", "确定性视频引擎 · 有声音了");
  });
  return { title: "Code Video" };
});

const act2 = act1.cutTo(2000, (prev, env) => {
  env.spawn(bgScene, { key: "bg", forever: true }); // forever 链：背景跨段保活
  env.bgm({ url: "pad" }, { volume: 0.55, fadeIn: 400 }); // 循环铺底
  // 多实例 + 立体声摆位：同一音源左右各一击，重叠即叠加
  env.audio({ url: "blip" }, { at: 300, pan: -0.8, volume: 0.6 });
  env.audio({ url: "blip" }, { at: 340, pan: 0.8, volume: 0.6 });
  env.step(2000, (ctx) => {
    return title(
      ctx,
      `${prev.title} :: 第二幕`,
      `t = ${ctx.t.toFixed(0)}ms · 铺底循环 + 左右声像`,
    );
  });
  return { title: `${prev.title} 完` };
});

const act3 = act2.cutTo(800, (prev, env) => {
  env.audio({ url: "whoosh" }, { at: 0, volume: 0.8, fadeIn: 100 });
  env.step(800, (ctx) => {
    return title(ctx, "第三幕 · 收尾", `${prev.title} → 转场风声`);
  });
});
void act3;

// ---------- 播放控制 ----------

const stage = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
let paused = false;
let busy = false;

const sink = new PacedFrameSink(stage, () => paused);
let audio: { ctx: AudioContext; player: WebAudioPlayer } | null = null;
const pendingEvents: AudioTimelineEvent[] = [];

function ensureAudio(): { ctx: AudioContext; player: WebAudioPlayer } {
  if (audio) return audio;
  const ctx = new AudioContext();
  audio = { ctx, player: new WebAudioPlayer(ctx, makeSynthLoader(ctx)) };
  return audio;
}

playBtn.addEventListener("click", () => {
  if (busy) {
    // 播放中：暂停/继续（画面靠 paced sink 挂起，音频靠上下文挂起）
    paused = !paused;
    playBtn.textContent = paused ? "▶ 继续" : "⏸ 暂停";
    if (audio) void (paused ? audio.ctx.suspend() : audio.ctx.resume());
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
  pendingEvents.length = 0;
  const { ctx, player } = ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();
  player.stop();
  try {
    const result = await render(act1, {
      fps: 30,
      width: stage.width,
      height: stage.height,
      canvas: stage,
      exporter: sink,
      headless: false,
      onAudioScript: (events, durationMs) => {
        pendingEvents.push(...events);
        // 音频预排：事件表 → WebAudio 节点图（与视频同起点）
        void player.play(events, durationMs);
      },
      onProgress: (done, total) => {
        hud.textContent = `帧 ${done}/${total} · 音频事件 ${pendingEvents.length}`;
      },
    });
    hud.textContent = `完成：${result.frames} 帧 / ${result.durationMs}ms · 音频 ${pendingEvents.length} 事件（多实例/循环/声像）· 可重播`;
  } finally {
    busy = false;
    playBtn.disabled = false;
    playBtn.textContent = "▶ 重播";
  }
}

hud.textContent = "点「播放」开始（音频需用户手势解锁）";
playBtn.disabled = false;
playBtn.textContent = "▶ 播放";
