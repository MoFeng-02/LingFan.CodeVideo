/**
 * 角色层示例：把 LingFan.CodeCharacter 的程序化角色作为 CodeVideo 场景里的一层。
 *
 * 是什么：剧本用 `env.layer` 声明角色层（z 叠放与可见区间），宿主把角色渲染面
 *         挂在该层 id 上；每个渲染面收到引擎给的帧与时间 t，用它对角色求值并
 *         画出该时刻的指令流。角色不持有时间线——t 与 fps 全部来自引擎。
 * 怎么用：pnpm exec vite examples/character-layer --port 5175（页面打开即推演出画）
 * 注意事项：角色求值是异步外观的纯函数，绘制落在其微任务里，画面恒定滞后一帧；
 *          指令流是纯数据，嵌入方可以对 plan 做平移等重组后再执行。
 */
import { render, start } from "@lingfan-video/core";
import type { FrameIndex, Ms, SceneEnv } from "@lingfan-video/contracts";
import {
  CanvasBlitExporter,
  PacedPreviewExporter,
  createCanvas2dCompositor,
  createCompositeHost,
} from "@lingfan-video/infra";
import type {
  DrawingContext,
  DrawCommand,
  DrawPlan,
} from "@lingfan-character/renderer-canvas2d";
import { buildDrawPlan, draw } from "@lingfan-character/renderer-canvas2d";
import { createCharacterRuntime } from "@lingfan-character/kernel";
import { humanoidPack } from "@lingfan-character/example-humanoid";

const WIDTH = 960;
const HEIGHT = 540;
const DURATION_MS = 3600;
const FPS = 60;

const stage = document.getElementById("stage") as HTMLCanvasElement;
stage.width = WIDTH;
stage.height = HEIGHT;
const hud = document.getElementById("hud") as HTMLDivElement;

/** 角色求值运行时：对 CodeVideo 而言它只是「t → 指令流」的纯函数封装 */
const runtime = createCharacterRuntime(humanoidPack);

/** 归一化平面整体平移：角色内容占短边见方区域，水平居中用 */
function shiftX(
  m: DrawCommand["transform"],
  dx: number,
): DrawCommand["transform"] {
  return [m[0], m[1], m[2], m[3], m[4] + dx, m[5]];
}

/** 角色层渲染面：绘制到引擎给的 t 时刻状态；plan 允许嵌入方重组后再执行 */
function createCharacterSurface(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d") as unknown as DrawingContext;
  const scale = Math.min(width, height);
  /** 角色内容占短边见方区域：水平居中把归一化平面整体平移 */
  const offsetX = (width - scale) / 2;
  let plan: DrawPlan | null = null;

  return {
    id: "character",
    width,
    height,
    canvas,
    render(_frame: FrameIndex, t: Ms): void {
      if (plan) {
        draw(ctx, plan);
      }
      void runtime.computeAt(t).then((state) => {
        const compiled = buildDrawPlan(state, scale);
        plan = {
          ...compiled,
          commands: compiled.commands.map((command) => ({
            ...command,
            transform: shiftX(command.transform, offsetX),
          })),
        };
      });
    },
  };
}

/** 背景层：纯色底与时间读数，体现层叠放次序 */
function createBackdropSurface(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return {
    id: "backdrop",
    width,
    height,
    canvas,
    render(_frame: FrameIndex, t: Ms): void {
      ctx.fillStyle = "#0b0f18";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#93a4c4";
      ctx.font = "14px 'Cascadia Mono', Consolas, monospace";
      ctx.fillText(
        `t = ${t.toFixed(0)}ms · 采样 ${FPS} FPS · 角色层 z=1`,
        24,
        32,
      );
    },
  };
}

const root = start(DURATION_MS, (env: SceneEnv): void => {
  env.layer({ id: "backdrop", z: 0, from: 0, to: DURATION_MS });
  env.layer({ id: "character", z: 1, from: 0, to: DURATION_MS });
  env.step(DURATION_MS, () => undefined, { fps: 30 });
});

async function main(): Promise<void> {
  const base = document.createElement("canvas");
  base.width = WIDTH;
  base.height = HEIGHT;
  const host = createCompositeHost({
    base,
    width: WIDTH,
    height: HEIGHT,
    surfaces: {
      backdrop: createBackdropSurface(WIDTH, HEIGHT),
      character: createCharacterSurface(WIDTH, HEIGHT),
    },
    candidates: [() => createCanvas2dCompositor()],
  });
  const sink = new PacedPreviewExporter({ clock: () => performance.now() });
  const result = await render(root, {
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    canvas: base,
    exporter: new CanvasBlitExporter(sink, stage),
    painter: host,
    frames: "allow-blank",
    headless: false,
    onProgress: (done, total) => {
      hud.textContent = `帧 ${done}/${total}`;
    },
  });
  hud.textContent = `完成：${result.frames} 帧 / ${result.durationMs}ms · 角色层由引擎时间驱动`;
}

void main();
