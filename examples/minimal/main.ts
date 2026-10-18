/**
 * 最小示例：三章、每章一个小片段周期、两种接法（链式 cutTo / 重叠窗 transitionTo）、真的出画。
 *
 * 只用契约：`start(窗口)`、`scene.cutTo(窗口, body)`、`env.transitionTo(下一章, { overlapMs })`
 * 组链；`env.step(窗口, fn, { fps })` 声明采样密度；`env.loop({ ms, times })` 是片段自己的周期；
 * `env.layer` 声明画面层，宿主按 id 交面，层画的就是 fn 这一帧算出的读数。
 *
 * 跑法：pnpm exec vite examples/minimal --port 5174（页面打开即出画）
 */
import { render, start } from "@lingfan-video/core";
import type { SceneEnv } from "@lingfan-video/contracts";
import {
  CanvasBlitExporter,
  PacedPreviewExporter,
  createCanvas2dCompositor,
  createCompositeHost,
} from "@lingfan-video/infra";

const CHAPTERS = [800, 600, 400] as const;
/** 第一处是链式硬接（无重叠）；第二处过场重叠 150ms */
const OVERLAPS: readonly number[] = [0, 150];
const POOL =
  CHAPTERS.reduce((sum, ms) => sum + ms, 0) -
  OVERLAPS.reduce((sum, ms) => sum + ms, 0);

const WIDTH = 960;
const HEIGHT = 540;
const stage = document.getElementById("stage") as HTMLCanvasElement;
stage.width = WIDTH;
stage.height = HEIGHT;
const hud = document.getElementById("hud") as HTMLDivElement;

/** fn 每帧写进来：层画的就是这一帧刚算出的读数，不按时间反查 */
const latest = {
  chapter: 0,
  local: 0,
  progress: 0,
  fps: 0,
  carried: null as number | null,
};
const COLORS = ["#4d6bfe", "#a8beff", "#ffc778"] as const;

/** 章首时刻：窗口与重叠累加得出的版面数据，不是时间源 */
function chapterStart(index: number): number {
  let at = 0;
  for (let i = 0; i < index; i += 1) {
    at += CHAPTERS[i]!;
    at -= OVERLAPS[i] ?? 0;
  }
  return at;
}

/** 一层画面：章号、采样密度、段内毫秒、三条章进度、接法与承接关系 */
function createReadout() {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = canvas.getContext("2d")!;

  const paint = (): void => {
    g.fillStyle = "#05070c";
    g.fillRect(0, 0, WIDTH, HEIGHT);

    g.font = "600 132px 'Segoe UI', 'PingFang SC', sans-serif";
    g.fillStyle = COLORS[latest.chapter] ?? "#a8beff";
    g.fillText(String(latest.chapter + 1), 72, 218);

    g.font = "16px 'Cascadia Mono', Consolas, monospace";
    g.fillStyle = "#93a4c4";
    g.fillText(`采样 ${latest.fps} FPS`, 76, 262);
    g.fillText(`段内 ${latest.local.toFixed(0)}ms`, 76, 286);
    g.fillText(
      latest.carried === null
        ? "链首"
        : `承接上一章返回值 chapter=${latest.carried}`,
      76,
      330,
    );

    const barX = 76;
    const barW = WIDTH - 152;
    for (let index = 0; index < CHAPTERS.length; index += 1) {
      const y = 402 + index * 38;
      const begin = chapterStart(index);
      const width = (CHAPTERS[index]! / POOL) * barW;
      g.fillStyle = "#141b2b";
      g.fillRect(barX, y, width, 10);
      g.fillStyle = COLORS[index]!;
      const filled =
        index < latest.chapter
          ? 1
          : index === latest.chapter
            ? latest.progress
            : 0;
      g.fillRect(barX, y, width * Math.min(1, Math.max(0, filled)), 10);
      g.fillStyle = "#93a4c4";
      g.font = "12px 'Cascadia Mono', Consolas, monospace";
      const joint =
        index === 0
          ? ""
          : OVERLAPS[index - 1]
            ? ` · 与上一章重叠 ${OVERLAPS[index - 1]}ms`
            : " · 链式硬接";
      g.fillText(
        `第 ${index + 1} 章 · ${begin}–${begin + CHAPTERS[index]!}ms${joint}`,
        barX,
        y - 6,
      );
      g.font = "16px 'Cascadia Mono', Consolas, monospace";
    }
  };

  return {
    surface: {
      id: "readout",
      width: WIDTH,
      height: HEIGHT,
      canvas,
      render(): void {
        paint();
      },
    },
  };
}

/** 一章：自己的周期（loop 不占帧窗池）+ 一路状态采样（step，按本章的 fps） */
function chapter(index: number, fps: 30 | 60 | 120) {
  return (env: SceneEnv): void => {
    env.par([
      (b) => b.loop({ ms: 200, times: 4, fn: () => undefined }),
      (b) =>
        b.step(
          CHAPTERS[index]!,
          (ctx) => {
            console.log(ctx.deltaTime, ctx.t, ctx.localT);
            latest.chapter = index;
            latest.local = ctx.localT;
            latest.progress = ctx.progress;
            latest.fps = ctx.fps;
            return { chapter: index, progress: ctx.progress };
          },
          { fps },
        ),
    ]);
  };
}

// 第一处：链式硬接。cutTo 返回下一章，链根要自己留着（能推演的是根）
const root = start(CHAPTERS[0], (env) => {
  env.layer({ id: "readout", z: 0, from: 0, to: POOL });
  chapter(0, 30)(env);
  return { chapter: 0 }; // body 返回值 = 下一章拿到的 prev
});
// 第二处：重叠窗过场，两章同时在跑
const third = start(CHAPTERS[2], (env) => chapter(2, 120)(env));
root.cutTo(CHAPTERS[1], (prev, env) => {
  latest.carried = prev.chapter ?? null;
  chapter(1, 60)(env);
  env.transitionTo(third, { overlapMs: OVERLAPS[1] });
});

async function main(): Promise<void> {
  const base = document.createElement("canvas");
  base.width = WIDTH;
  base.height = HEIGHT;
  const readout = createReadout();
  const host = createCompositeHost({
    base,
    width: WIDTH,
    height: HEIGHT,
    surfaces: { readout: readout.surface },
    candidates: [() => createCanvas2dCompositor()],
  });
  const sink = new PacedPreviewExporter({ clock: () => performance.now() });
  const result = await render(root, {
    fps: 60,
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
  hud.textContent =
    `完成：${result.frames} 帧 / ${result.durationMs}ms` +
    ` · 链式 cutTo → 重叠 transitionTo`;
}

void main();
