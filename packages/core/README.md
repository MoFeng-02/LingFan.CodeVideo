# @lingfan-video/core

Code Video 引擎的实现包：纯域层（编译 / 校验 / 时间数学 / 确定性随机）+ 引擎运行时 + 库形态组合根。

## 它是什么

`src/index.ts` 是**唯一全知模块**：它装配引擎、接上默认适配器，并把契约的三个实现交出去。
包内分层 `app → domain → contracts`，`app` 不 import `infra`——平台能力一律由调用方注入。

## 怎么用

```ts
import { start, render, compute, validateScene } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const scene = start(1000, (env) => {
  env.step(1000, (ctx) => {
    // 浏览器环境：ctx.canvas 是真实画布，画上去的像素就是导出帧
    ctx.canvas.getContext("2d")!.fillRect(ctx.t / 4, 0, 40, 40);
  });
});

await render(scene, { fps: 30, width: 640, height: 360, exporter: new FrameSequenceExporter() });
```

Node 环境没有可回读的画布：要么注入 `painter` 自绘帧，要么显式声明 `frames: "allow-blank"` 表示本次不需要真实像素（缺省会报 `spec_violation`，不会静默交空白帧）。

## 公共出口

按用途分四组（完整签名以 `src/index.ts` 为准）：

| 用途 | 出口 |
| --- | --- |
| 契约实现 | `render`（`RenderFn`）、`compute`（`ComputeFns`，含 `computeAt` / `computeRange`）、`validateScene`（`ValidateFn`） |
| 写剧本 | `start`（= `startScene`）、`createScene`；音频组合子 `clip` / `gain` / `pan` / `loop` / `rate` / `warp` / `curve` / `fadeIn` / `fadeOut` / `ramp` |
| 自建推演 | `TimelineEngine`、`compileAudioProgram`、`createInputTrack`、`createRandomStream` |
| 时间与数学 | `timestampAt` / `msToFrames` / `framesToMs` / `frameCount`、`beatGrid` / `msPerBeat`、`coverProgress`、`poolOf` / `loopPool` |

## 三条纪律

1. **帧是算出来的**：像素来源只有一处——绘制目标本身（或注入的 `painter`）。没有第二份来源，也不会静默交空白帧。
2. **时间以毫秒为准**：`fps` 只是采样密度；单元可声明自己的 `fps`（三级继承：单元 > spawn 链 > `RenderOptions.fps`）。
3. **平台能力注入**：画布、编码器、音频设备、资产解码都由调用方给；本包不认 `window` / `document`。

## 读什么

- 想理解引擎怎么运作：[`docs/mental-model.md`](../../docs/mental-model.md)
- 想写剧本：[`docs/guides/first-clip.md`](../../docs/guides/first-clip.md) 起，按任务走 [`docs/README.md`](../../docs/README.md)
- 想接自己的适配器：[`docs/contracts/`](../../docs/contracts/index.md)
