/**
 * 示例 1：三幕链式剧本。
 * 跑法：pnpm tsx examples/three-acts.ts（无 DOM 依赖，headless 输出帧序元数据）。
 *
 * 第一幕 1s：标题淡入（step 返回 body 状态 → 下一幕 prev）
 * 第二幕 2s：用 prev 的标题做主内容，spawn 挂 forever 背景链
 * 第三幕 0.5s：transitionTo 提前收窗短路
 */
import { start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";
import type { SceneEnv } from "@lingfan-video/contracts";

function drawTitle(env: SceneEnv, text: string) {
  // painter 当前为 CPU 占位（全 0 位图）：绘制回调在此只演示 ctx 形状
  void env;
  return { title: text };
}

const act1 = start(1000, (env) => {
  env.step(1000, (ctx) => drawTitle(ctx, "Code Video"));
  return { title: "Code Video" }; // body 返回值 = 下一幕 prev
});
const act2 = act1.cutTo(2000, (prev, env) => {
  const title = (prev as { title?: string }).title ?? "";
  env.spawn(bgScene, { key: "bg", forever: true }); // 跨段背景：forever 链
  env.step(2000, (ctx) => drawTitle(ctx, `${title} :: 主内容 ${ctx.t}ms`));
  return { title: `${title} 完` };
});
const act3 = act2.cutTo(500, (prev, env) => {
  env.step(300, (ctx) =>
    drawTitle(ctx, `收尾 ${(prev as { title?: string }).title?.slice(0, 10)}`),
  );
  env.transitionTo(credits);
});
// cutTo 返回链尾：render/compute 一律从 head（act1）出发（时间线语义）
void act3;

const bgScene = start(400, (env) => {
  env.step(400, (ctx) => drawTitle(ctx, `bg ${ctx.frameIndex}`));
});

const credits = start(800, (env) => {
  env.step(800, (ctx) => drawTitle(ctx, `credits ${ctx.totalTime}ms`));
});

const exporter = new FrameSequenceExporter();
const { render } = await import("@lingfan-video/core");
const result = await render(act1, {
  fps: 30,
  width: 640,
  height: 360,
  exporter,
  headless: true,
  onProgress: (done, total) => process.stdout.write(`\r帧 ${done}/${total}`),
});
process.stdout.write(`\n完成：${result.frames} 帧 / ${result.durationMs}ms\n`);
