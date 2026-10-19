---
name: codevideo-scene
description: 写一段幕里的逐帧画面与状态：start 的三重载 / env.step 与 StepContext 的完整能力集 / step vs wait vs loop vs par 的选择 / 返回值如何聚合成全片状态。Use when authoring a single scene's frame callback, choosing between step and wait, or deciding what a frame function may read.
metadata:
  version: "2.0.0"
---

# 单幕剧本

一段幕由**窗口长度 + 登记体**构成；登记体只登记节点，不执行画面。画面在推演期由 `step` 回调按采样网格逐帧算出。项目思维：**帧函数是纯函数**——同一输入必得同一画面，任何从外部世界「偷时间」（`Date.now()` / `performance.now()` / 模块级可变量）的写法都在破坏这个前提。

## 何时用 / 何时不用

- 用：从零写第一段能出帧的剧本；改某一幕里逐帧画什么、返回什么状态；判断该用 `step` 还是 `wait`。
- 不用：要拼接多幕或处理幕间过渡 → `codevideo-schedule`；要发声 → `codevideo-audio`；要出片 → `codevideo-export`。

## API 面备查（签名以源码为准）

| 你要 | API | 要点 |
| --- | --- | --- |
| 建首幕 | `start(windowMs, env => {...})` | 三重载：`(windowMs, body)` / `start(0, windowSec, body)` 秒糖 / `start({ window, setup?, run })` |
| 建帧窗 | `env.step(durationMs, fn)` | 消耗总毫秒池与帧窗池；fn 返回 `FrameState` 即发布状态 |
| 降采样 | `env.step(fn, { fps: 1 })` | 整窗只按 1fps 求值；省着用帧窗池 |
| 只占时不出画 | `env.wait(ms, onUpdate?)` | 不产帧；onUpdate 只在与其他活跃单元共用的网格点触发 |
| 循环节奏 | `env.loop({ ms?, times?, fn, fps?, id? })` | 后台并行，不推进父游标；`fn(ctx)` 用 `next()`/`stop()` 自管 |
| 并行分支 | `env.par([b => ..., b => ...])` | 每分支独立 `SceneEnv`，共享同一窗口 |
| 登记层 | `env.layer({ id, z?, blend?, from?, to? })` | 纯声明：不推进游标、不占帧窗池 |

`StepContext` 能力集（`packages/contracts/src/scene/nodes.ts`）：画面 `canvas`/`width`/`height`/`f`；时间 `t`（全局毫秒）/`frameIndex`（本单元 0 起）/`totalTime`/`deltaTime`/`localT`/`duration`/`progress`（= `localT/duration`，0..1）；能力 `input`（同帧共享的输入快照）/`fps`（本单元有效帧率）/`random`（种子派生）/`audio`/`synth`/`bus`（运行期发声，见 `codevideo-audio`）/`spawn`/`scheduler`/`once`/`dispose`。

`WaitContext` **刻意不含** `canvas`/`step`/`loop`/`spawn`/`par`：不产帧的窗若能画、能开新产帧路径，「空窗不产帧」的导出优化就失真了。

## 硬约束

1. **登记期不执行画面**。`env` 回调里只能登记节点（`step`/`wait`/`loop`/`par`/`layer`/`spawn`/音频登记）。在登记体里画图、读时钟、发请求都不生效。
2. **窗口必须被登记体消耗完**。登记体结束时缺口不会自动补齐；越界则编译期 `window_overflow`。先 `validate(scene)` 验。
3. **帧函数的唯一输入是 `ctx`**。读外部可变变量 = 放弃确定性；需要变化用 `ctx.random`（种子派生，两次推演相同）或返回值聚合。
4. **`fps` 不是时间单位**。`ctx.t`/`ctx.localT`/`ctx.duration` 全是毫秒；`ctx.frameIndex` 是本单元序号，`f(n) = n × (1000 / ctx.fps)`——跨单元帧号不可比，对齐时刻只用毫秒。
5. **画面尺寸来自 `ctx`**。用 `ctx.width`/`ctx.height`，不读全局 `window`。
6. **状态按 key 合并**。`step` 回调返回 `Record<string, unknown>`，按返回键合并成全片一份状态包；`compute.computeAt(scene, t)` 取到的就是这份包在 ≤t 最近采样点的快照。

## 骨架

```ts
import { start } from "@lingfan-video/core";

const scene = start(1000, (env) => {
  env.step(1000, (ctx) => {
    const g = (ctx.canvas as HTMLCanvasElement).getContext("2d")!;
    g.clearRect(0, 0, ctx.width, ctx.height);
    g.fillRect(ctx.progress * (ctx.width - 40), ctx.height / 2, 40, 40);
    return { progress: ctx.progress };   // FrameState：按 key 合并成全片状态包
  });
});
```

组合方式（一段幕内可以混用）：

```ts
const scene = start(3000, (env) => {
  env.layer({ id: "hud", z: 10 });                 // 先声明层，画面归属由宿主注入
  env.step(3000, (ctx) => drawMain(ctx));          // 主画面：整窗满采样
  env.step((ctx) => drawWatermark(ctx), { fps: 1, id: "mark" }); // 降采样：整窗 3 个采样点
  env.wait(800, (ctx) => {                          // 静默段：只在与主画面共用的网格点回调
    if (ctx.progress > 0.5) ctx.audio(hit);         // 静默段里也能发声
  });
  env.loop({ ms: 250, times: 4, fn: (ctx) => {      // 循环：每 250ms 一轮，共 4 轮
    drawPulse(ctx.iterationProgress);
  }, id: "pulse" });
});
```

## 验证判据

```bash
pnpm vitest run tests/engine-timeline.test.ts tests/validate-pool.test.ts
```

- 帧数与时长：`render` 返回的 `{ frames, durationMs }` 应满足 `durationMs` = 登记的窗口总和。
- 语义：`compute.computeAt(scene, t)` 取 ≤t 的最近采样点状态，与手算的 `progress` 对照。
- 结构：`validate(scene)` 返回空数组即通过。

## 常见错法

| ✗ 错法 | 为什么错 | ✓ 改成 |
| --- | --- | --- |
| 在 `env` 回调里直接画图 | 登记期不执行画面，那段代码根本不跑 | 画图写进 `env.step(ms, fn)` 的 `fn` |
| `const total = 3000; const p = ctx.t / total` | 自己引入「全片总长」概念，链一改就错 | `ctx.progress`（本单元内 0..1） |
| 把 `ctx.frameIndex` 当全片帧号 | 它是本单元序号，全片帧数只有组合根知道 | 需要进度用 `ctx.progress`；需要时刻用 `ctx.t` |
| `env.step(fn)` 不传时长，靠猜 | 单位变成「按 `fps` 的一帧」，容易写出意料外的窗口 | 显式传毫秒：`env.step(800, fn)` |
| 在 `fn` 里读模块级 `let counter` 累加 | 两次推演会得到不同画面，确定性丢失 | 用 `ctx.random`（种子派生）或返回值聚合 |
| 用 `wait` 画帧 | wait 不产帧，纯空窗零采样点 | 要逐帧就用 `env.step(ms, fn)` |
