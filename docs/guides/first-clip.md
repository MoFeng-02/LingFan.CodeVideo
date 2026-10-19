# 第一段剧本：从零到出帧

用 `start` 登记一段有毫秒窗口的剧本、用 `env.step` 声明逐帧回调，再用 `render` 把帧交给 `FrameSequenceExporter` 收下——能力由剧本 DSL（端口 `Scene` / `SceneEnv`，`packages/contracts/src/scene/`）与渲染入口（端口 `RenderFn`，`packages/contracts/src/entry/ports.ts`）承载，逐帧位图由适配器 `FrameSequenceExporter`（`packages/infra/src/export/frame-sequence-exporter.ts`）落地。

## 何时用 / 何时不用

- **用**：第一次写剧本要验证链路通；需要拿到逐帧 CPU 位图做断言或再加工；确定「这段到底出多少帧、每帧时间戳是多少」。
- **不用**：多幕拼接与过场 → `compose-acts.md`；要声音 → `add-audio.md`；要 mp4 文件 → `export-mp4.md`；不想整片跑一遍就想验证 → `debug-with-compute.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 两参 `start(窗口, body)` 的窗口就是这一幕的毫秒长度 | `start(1500, …).duration === 1500` | `tests/dsl-chain.test.ts`「2 参：windowMs + body」 |
| 秒糖写法 `start(0, 1.5, body)` 等价 1500ms（首参写 0 才启用秒） | `.duration === 1500` | `tests/dsl-chain.test.ts`「3 参：0 + 秒糖 + body」 |
| 没有产帧单元的剧本不产帧 | 帧数 0，不报错 | `tests/engine-timeline.test.ts`「空剧本（无任何单元）不产帧：语义层单位是毫秒，采样密度由活跃单元决定」 |
| 帧号到时间的换算是逐帧乘法，不是累加 | `timestampAt(i, fps) === i * (1000 / fps)` | `tests/time-math.test.ts`「timestampAt = frameIndex * (1000/fps)，恒等乘法」 |
| 没有帧来源时首帧报 `spec_violation`，不静默交空白帧 | 抛错且文案指向缺少 painter / 2D 上下文 | `tests/frame-source.test.ts`「无 painter 且无 2D 上下文 → spec_violation（不静默交空白帧）」 |
| 显式 `frames: "allow-blank"` 才接受零位图 | 同一剧本带该选项出帧成功 | `tests/frame-source.test.ts`「显式 frames:"allow-blank" 才给零位图（预览 sink 自绘等场景）」 |

## 用法

登记的写法（可直接跑，Node 下靠 `headless` + `allow-blank` 拿占位位图）：

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

// 1) 登记：只记节点，不执行画面。1000ms 是这一幕的窗口长度。
const clip = start(1000, (env) => {
  env.step(1000, (ctx) => ({
    at: ctx.t, // 全局时间线毫秒
    local: ctx.localT, // 本段起点算起
    frame: ctx.frameIndex, // 本单元帧号
  }));
});

// 2) 推演：逐帧求值，帧交给导出器
const exporter = new FrameSequenceExporter();
const result = await render(clip, {
  fps: 30, // 必填：采样密度，不是播放速度
  width: 640, // 必填：像素
  height: 360, // 必填：像素
  exporter, // 必填：没有渲染后端就没有产物
  frames: "allow-blank", // 缺省 "required"，即必须真有像素来源
  headless: true, // 缺省 false
});

console.log(result.frames, result.durationMs); // 30 帧 / 1000ms
console.log(exporter.frames.length); // 30
console.log(exporter.timestamps[1]); // 33.33…ms = 1 × (1000/30)
```

### 登记期不执行画面

`start` 与 `cutTo` 的 body 只做一件事：把节点（`step` / `wait` / `loop` / `par` / `spawn` / 音频 / 层）挂到游标上。body 会被跑，但**跑的时候没有画布、也不产帧**。

这条纪律的直接后果：

- 同一份剧本会被登记不止一遍——`validateScene` 干跑一遍、`compute` 每调用一次各建一次引擎、`render` 再登记一遍。任何一遍里碰真实 DOM、读 `performance.now()`、发网络请求，都会让结果随次数漂移。
- 干跑时画布是空实现（`validate` 用 `null` 画布装配），所以 body 里不许依赖 `env.canvas` 是真的 2D 画布。
- 帧内编译的例外只有一处：运行期 `ctx.spawn` 的场景在帧内编译，这类场景的 `setup` 必须同步。

### `ctx` 上有什么

`StepContext` 的能力分三档，缺的那一档就是语义声明：

| 档位 | 成员 | 说明 |
| --- | --- | --- |
| 时间与位置 | `t` `frameIndex` `totalTime` `localT` `duration` `progress` | `progress = localT / duration`，0..1 |
| 采样 | `fps` `deltaTime` `f(n)` | `fps` 是本单元有效帧率（`单元 fps > spawn 链 fps > RenderOptions.fps`），`deltaTime = 1000 / fps`，`f(n) = n * (1000 / fps)` |
| 画面 | `canvas` `width` `height` | `width`/`height` 是本次推演的像素尺寸 |
| 能力 | `audio` `synth` `bus` `send` `duck` `random` `spawn` `scheduler` `dispose` `once` `input` | 见 `add-audio.md` 与 `compose-acts.md` |

`wait` 的回调拿到的是 `WaitContext`，**刻意不含** `canvas` / `step` / `loop` / `spawn` / `par`：这段不产帧。

### 怎么确认跑对了

按顺序看四个数，任何一个不对就停在这一步：

1. `result.frames` 等于「窗口 × 采样密度」按网格数出来的点——1000ms / 30fps = 30 帧，且第一帧在 0ms。
2. `result.durationMs` 是时间线长度（1000ms），不是最后一帧时间戳。
3. `exporter.timestamps` 第 i 项等于 `i * (1000 / 30)`，最后一帧 966.67ms——**导出器自己的 `durationMs` 取最后一帧时间戳**，与时间线长度不是一回事。
4. `exporter.frames[0]` 是 `{ data, width, height }` 形状的 CPU 位图（`kind` 省略即 bitmap），`data.length === width * height * 4`。

拿不到像素时不要靠猜：`validateScene(clip)` 返回错误表（空数组才是通过），帧指纹与差分的判据在 `debug-with-compute.md`。

## 反例

✗ **在 body 里直接动 DOM 或画布**

> 伪代码

```ts
const clip = start(1000, (env) => {
  document.body.append(canvas); // 登记期就碰宿主
  env.step(1000, () => draw(canvas));
});
```

为什么错：登记期跑 body 时不保证有宿主，干跑一遍就会炸；就算不炸，`validate` / `compute` / `render` 各登记一遍意味着重复副作用。改成把副作用放进逐帧回调：

✓

> 伪代码

```ts
const clip = start(1000, (env) => {
  env.step(1000, (ctx) => draw(ctx)); // 画面只在推演时算
});
```

✗ **用墙钟当时间源**

> 伪代码

```ts
env.step(1000, () => ({ x: performance.now() / 4 }));
```

为什么错：帧内容必须只是「帧号 + 注入数据」的函数，否则两遍推演得到不同指纹，`auditDeterminism` 直接失败（见 `debug-with-compute.md`）。

✓

> 伪代码

```ts
env.step(1000, (ctx) => ({ x: ctx.t / 4 }));
```

✗ **在 Node 下用缺省帧来源跑**

不注入 `painter`、不给 2D 画布、也不开 `headless`，首帧就抛 `spec_violation`（文案指明「不会静默导出空白帧」）。

✓ 三选一：注入 `painter`（自绘宿主）、给可 `getContext("2d")` 的 `canvas`、或 `headless: true` 且显式 `frames: "allow-blank"`。

## 边界与陷阱

- `frames` 缺省 `"required"`：既无 painter 又无 2D 上下文时首帧即报错；`"allow-blank"` 只是接受全 0 占位位图，不改变「必须有帧来源」这件事。
- `FrameSequenceExporter` 只收 CPU 位图：遇到 `kind: "handle"` 的设备句柄直接抛错，提示改用 `WebCodecsExporter` 或让宿主回读。
- `FrameSequenceExporter` 的像素全留在对象里（`frames` / `timestamps` 两个 getter），内存随帧数线性增长；长片请改编码路径或流式 sink。
- `headless` 只影响画布来源的选择，不影响帧序列：像素由 painter 决定，引擎不读绘制目标。
- 时长单位统一毫秒；`durationMs` 与帧数不对应时先查采样密度，不要补帧。
- `render` 的 `exporter` 必填，缺了在首帧前就抛错（`render 需要 RenderOptions.exporter`）。

## 相关

- 端口源码：`packages/contracts/src/scene/entities.ts`（`Scene` / `SceneEnv` / `StartSpec`）、`packages/contracts/src/scene/nodes.ts`（`StepContext` / `StepOptions`）、`packages/contracts/src/entry/ports.ts`（`RenderOptions` / `RenderResult`）、`packages/contracts/src/export/ports.ts`（`Exporter`）、`packages/infra/src/export/frame-sequence-exporter.ts`。
- 示例：`examples/three-acts/main.ts`（最小可跑链）、`examples/minimal/main.ts`（真出画）。
- 相邻页：`compose-acts.md`（多幕）、`add-audio.md`（声音）、`export-mp4.md`（出片）、`debug-with-compute.md`（不整片验证）、`../mental-model.md`（六条不变量）。
