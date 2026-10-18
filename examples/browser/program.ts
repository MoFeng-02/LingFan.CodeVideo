/**
 * 三幕剧本：与 examples/three-acts.ts 同构，fn 直接在 ctx.canvas 上 2d 绘制。
 *
 * 抽成独立文件的原因：主入口 main.ts 只负责预览/导出的外围接线，
 * 剧本本身是可替换的内容层——换一段剧本不该动播放与编码代码。
 * 幕间用重叠窗（transitionTo(next, { overlapMs })）+ 绝对时间黑场遮盖，
 * 出幕遮到全黑、入幕从全黑揭开，切点两侧读同一个 ctx.t。
 */
import { coverProgress, createScene, start } from "@lingfan-video/core";
import { clip, gain, loop, pan, warp } from "@lingfan-video/core";
import type { AudioHandle, Scene, StepContext } from "@lingfan-video/contracts";
import { drawInputOverlay } from "./input-overlay";

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

/**
 * 幕间叠化：黑场先遮满、再揭开。
 * 出幕与入幕都读**绝对时刻**（ctx.t），所以两段各自算出的遮盖量在切点严丝合缝；
 * 若改成各自的 localT，入幕会在切点把遮盖量从 0 重算，看上去闪一下。
 */
const SEAM = { from: 2800, hold: 100, reveal: 100 } as const;

function drawCurtain(ctx: StepContext, alpha: number): void {
  if (alpha <= 0) return;
  const g = (ctx.canvas as HTMLCanvasElement).getContext("2d")!;
  g.save();
  g.globalAlpha = Math.min(1, alpha);
  g.fillStyle = "#06060c";
  g.fillRect(0, 0, ctx.width, ctx.height);
  g.restore();
}

/** 出幕：遮到全黑；入幕：从全黑揭开 */
function seamCurtain(ctx: StepContext, side: "out" | "in"): number {
  return side === "out"
    ? coverProgress(ctx.t, SEAM.from, SEAM.hold)
    : 1 - coverProgress(ctx.t, SEAM.from + SEAM.hold, SEAM.reveal);
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
    // 输入面：读取本帧快照（事件表是数据，不是实时鼠标）
    drawInputOverlay(ctx);
    const shown = title(
      ctx,
      `${prev.title} :: 第二幕`,
      `t = ${ctx.t.toFixed(0)}ms · 铺底循环 + 现场发起 + 节拍变速`,
    );
    // 出幕：最后 100ms 遮到全黑，与第三幕的开场揭开接上（重叠窗 = 200ms）
    drawCurtain(ctx, seamCurtain(ctx, "out"));
    return shown;
  });
  env.transitionTo(act3, { overlapMs: 200 });
  return { title: `${prev.title} 完` };
});

const act3 = createScene<{ title: string }>(800, (prev, env) => {
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
    // 入幕：黑场还没揭开时不画（让第二幕的收黑留在画布上，接缝才不会跳）
    const reveal = seamCurtain(ctx, "in");
    if (reveal >= 1) return;
    bg(ctx); // 整幅重绘（预览不逐帧清屏，未重绘的区域会留下上一帧）
    const shown = title(
      ctx,
      "第三幕 · 收尾",
      `${prev.title} → 转场风声 + 加速收束`,
    );
    drawCurtain(ctx, reveal);
    return shown;
  });
});
void act2;
export { act1 };
void act3;
