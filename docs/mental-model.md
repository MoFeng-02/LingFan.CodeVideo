# 心智模型

一段视频在本仓不是文件，而是一段**跑 N 毫秒的确定性程序**：剧本登记节点 → 编译成双池时间线
（总毫秒池 / 帧窗池）→ 按采样网格逐帧求值 → 交出帧载体 → 编码封装。帧不是录下来的，是算出来的。

推演入口是 `render(scene, options)`（`packages/core/src/index.ts`），出口是 `Exporter`（`packages/contracts/src/export/ports.ts`）。

## 何时用 / 何时不用

- 用：需要「同一份剧本每次推演出逐帧相同结果」的成片、需要把画面当函数写、需要模型直接产出可跑剧本。
- 不用：需要实时采集外部视频源、需要非线性剪辑时间轴、需要用户实时操作决定画面的交互应用。
  本仓不做录制，也不做可玩形态——输入只能是声明式数据（事件表），不是设备。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 同一剧本 + 同一注入 → 同一帧序列 | 两次推演的帧指纹序列逐项相等 | `tests/frame-diagnostics.test.ts` |
| 总时长是编译产物，不是设计参数 | 不存在任何「全片总长」入参；总长由链上窗口累加（重叠窗相减） | `tests/dsl-chain.test.ts` |
| 时间语义是毫秒，`fps` 只决定采样密度 | 改变 `fps` 不改变同一 `t` 上的语义 | `tests/engine-timeline.test.ts` |
| 采样点 = 各活跃单元网格点并集 | 时间戳严格递增，且空窗不产帧 | `tests/engine-timeline.test.ts` |
| 帧号 → 毫秒是逐帧乘法 | `timestampAt(i, fps) === i * (1000 / fps)` | `tests/time-math.test.ts` |
| 三种注入路径不同源时必然报错，不静默降级 | 无帧来源且未声明 `allow-blank` → 首帧 `spec_violation` | `tests/backend-port.test.ts` |

## 用法

下面这段能直接解释引擎的全部形状：一段 1000ms 的首幕，帧画面是 `t` 的函数。

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const scene = start(1000, (env) => {
  env.step(1000, (ctx) => {
    const g = (ctx.canvas as HTMLCanvasElement).getContext("2d")!;
    g.clearRect(0, 0, ctx.width, ctx.height);
    g.fillRect(ctx.t / 4, 0, 40, 40); // 同一个 t 必然同一个画面
  });
});

await render(scene, {
  fps: 30,
  width: 640,
  height: 360,
  headless: true,
  exporter: new FrameSequenceExporter(),
});
```

读这段代码时按四层理解：

1. **登记期**（`env` 回调）：只登记节点，不执行画面。`env.step(1000, fn)` 消耗 1000ms 的秒池，
   并按「窗口 × 有效帧率」贡献帧窗池。
2. **编译期**：链被编译成双池时间线与采样网格；窗口越界、链成环、参数非法在此报错。
3. **推演期**（`ctx` 回调）：引擎在每个采样点调用活跃单元的 `fn`，`fn` 只读 `ctx`、写画面、返回状态。
4. **交出**：引擎把帧载体交给 `FrameSink` / `Exporter`，再交音频样本，最后封装。

## 反例

- ✗ 在剧本里写死全片时间表，再按「当前是第几毫秒」反查该画哪一镜。
  为什么错：导航权交给了一张外部表，链的推进、重叠窗、spawn 保活全部失效，且总长不再可编译。
  ✓ 改成：每一幕只声明自己的窗口，幕间用 `cutTo` / `transitionTo` 接；段内只用 `ctx.localT` / `ctx.progress` 取值。
- ✗ 用「进度百分比」驱动动画：`totalMs` 自己算、`ctx.t / totalMs` 当进度。
  为什么错：`ctx.t` 是全局时刻，除以全片总长就重新引入了「全片总长」概念。
  ✓ 改成：本单元内用 `ctx.progress`；跨幕节奏用 `coverProgress(atMs, fromMs, durationMs)` 这类纯函数。
- ✗ 把 `fps` 当「播放速度」，认为调高 `fps` 视频变短。
  为什么错：`fps` 只决定采样密度；时长由毫秒窗口决定，调高 `fps` 只会让同一时长有更多帧。
  ✓ 改成：要变快就缩短窗口毫秒数；要更顺滑才提高 `fps`。
- ✗ 在幕边界手动 `ctx.audio(...).stop()` 收声音，认为「换幕该断声」。
  为什么错：引擎不因幕/段/链边界自动杀声音，手动补刀会让剧情因果散落在各处。
  ✓ 改成：声音生命用 `ctx.once` 决定何时发、用句柄 `stop({ fadeOut })` 决定何时收，或在 `dispose` 里收。

## 边界与陷阱

- **确定性是分级的**：CPU 2D 路径承诺跨设备逐字节相同；GPU / 第三方框架只承诺同设备、同代码、同数据相同。
  做跨设备比对前先确认走的是哪一级。
- **注入不同则结果不同**：`fps`、宽高、`seed`、`input` 事件表、`assets` 任一项变了，就是另一次推演。
  预览与导出必须传同一份，否则两条路径会分叉。
- **空窗不产帧**：只有 `wait` 的区间没有采样点，因此 `wait` 的回调也只在与别的单元共用的网格点上被调用。
  需要这段真有逐帧逻辑，用 `step`。
- **节点类型决定能力集**：`StepContext` 能画能发能 spawn；`WaitContext` 刻意不含画面与推进能力；
  `LoopContext` 靠 `next()` / `stop()` 自管节奏、不推进父游标。用错上下文会在类型层被挡住。
- **帧的形态不止位图**：`FrameHandle` 表示设备侧句柄（不承诺 CPU 可读），所有权随 `writeFrame` 转移。
  走 GPU 路径时不要在适配器里偷偷回读像素。
- **平台能力全部注入**：`canvas` / `painter`、`exporter`、`audio`（离线混音）、`audioOutput`（实时发声）、
  `assets` 都由调用方给。组合根本身不认平台 API，因此 Node、浏览器、框架宿主走同一条路径。

## 相关

- 端口源码：`packages/contracts/src/entry/ports.ts`（`RenderOptions` / `RenderFn` / `ComputeFns`）、
  `packages/contracts/src/scene/`（剧本与节点）、`packages/contracts/src/capture/ports.ts`（帧接缝）
- 组合根：`packages/core/src/index.ts`
- 下一站：[`guides/first-clip.md`](guides/first-clip.md)、[`glossary.md`](glossary.md)
