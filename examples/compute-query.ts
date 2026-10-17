/**
 * 示例 2：computeAt / computeRange / validate（登记不重跑、快照可查询）。
 * 跑法：pnpm tsx examples/compute-query.ts
 */
import {
  start,
  compute,
  validateScene,
  createScene,
} from "@lingfan-video/core";

const scene = start(2000, (env) => {
  env.step(1000, (ctx) => ({ x: ctx.t, frame: ctx.frameIndex }));
  env.wait(500);
  env.step(500, (ctx) => ({ x: ctx.t * 2 }));
});

// 契约符合性：登记期干跑检查（越窗/重复链接/body 抛错）
const errors = validateScene(scene);
console.log("validate:", errors.length === 0 ? "✓ 无违规" : errors);

// 时间点查询：任意毫秒处的状态快照（key 化聚合）
const at600 = await compute.computeAt(scene, 600);
console.log("computeAt(600ms):", at600);

// 区间扫描：每 250ms 采样
const series = await compute.computeRange(scene, 0, 2000, 250);
console.log("computeRange 采样点数:", series.length);
console.log("末点:", series[series.length - 1]);

// 链式查询（注意：cutTo 返回链尾，查询要从 head 起——时间线语义）
const chainHead = createScene(300, (_prev, env) => {
  env.step(300, (ctx) => ({ phase: "a", t: ctx.t }));
});
chainHead.cutTo(300, (_prev, env) => {
  env.step(300, (ctx) => ({ phase: "b", t: ctx.t }));
});
const atB = await compute.computeAt(chainHead, 450); // 450ms 已进入第二幕
console.log("cutTo 链 @450ms:", atB);
