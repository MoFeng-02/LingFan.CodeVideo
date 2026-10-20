# 帧捕获（FrameCarrier / FrameSink / FrameSource / FrameHost / Painter）

画面从剧本里走到编码器之前的这一段：一帧在内存里以什么形态存在、由谁交出、由谁接收、谁负责释放。端口在 `packages/contracts/src/capture/ports.ts`，能力由 `Painter` 注入，实现由引擎（`packages/core/src/app/runtime/`）与各导出器（`packages/infra/src/`）承载。

## 何时用 / 何时不用

- 用：要把外部渲染器（三维引擎、离屏画布、别的框架的 DOM）的画面接进推演，因为 `Painter` 只要求按帧交出载体。
- 用：要在同一帧上叠多层再交给导出器，因为 `FrameHost.frame` 拿到的是采样网格点，不是均匀序号。
- 用：要把逐帧位图写进自己的存储，因为实现 `FrameSink` 就能接到整条交付链上。
- 用：想让 GPU 句柄不经 CPU 回读直达编码器，因为 `FrameHandle` 只承诺同设备消费端可用。
- 用：要透明画面，因为 `RenderOptions.alpha` 会随 `FrameHostInfo.alpha` 交给宿主，合成器据此决定每帧从哪种「干净」画布开始。
- 不用：只想在浏览器里显示预览，改用 `PacedPreviewExporter` / `CanvasBlitExporter`，见 `docs/guides/debug-with-compute.md`。
- 不用：只关心时间与声音、不需要像素，改用 `frames: "allow-blank"`，见 `docs/contracts/export.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 帧宿主按 `begin` → `frame`×N → `close` 的顺序被驱动，且 `begin` 的参数是一次推演的固定信息 | 调用序列与 `FrameHostInfo` 各字段在整次推演内不变 | `tests/frame-host.test.ts` |
| 重播会重新 `begin`：宿主状态不得跨推演沿用 | 两次推演各触发一次 `begin` | `tests/frame-host.test.ts` |
| `begin` 抛错则不再交帧、也不调 `close` | 调用记录只有 `begin` | `tests/frame-host.test.ts` |
| `close` 抛错时错误交回调用方，已经交出的帧不丢 | 调用方收到该错误且已交帧数不变 | `tests/frame-host.test.ts` |
| 推演失败且 `close` 也失败时两错都交回（聚合错误） | 错误里同时含推演失败与关闭失败 | `tests/frame-host.test.ts` |
| 异步取帧严格串行：慢源也不会同时存在两帧在飞 | 峰值在飞帧数为 1、总帧数不丢 | `tests/async-painter.test.ts` |
| 异步源按采样网格顺序交付，且与同步源同像素 | 帧序与时间戳单调，像素逐字节相等 | `tests/async-painter.test.ts` |
| 取帧失败即本次推演失败，不静默跳过该帧 | 渲染以错误结束 | `tests/async-painter.test.ts` |
| 缺省从绘制目标画布的 2D 上下文回读；注入 `painter` 后以注入为准 | 回读次数为 0、像素等于注入值 | `tests/frame-source.test.ts` |
| 既无 `painter` 又无 2D 上下文 → `spec_violation`，且不静默交空白帧 | 渲染抛错、导出器收 0 帧 | `tests/frame-source.test.ts` |
| 只有显式 `frames: "allow-blank"` 才交全 0 占位位图 | 位图每个字节为 0 | `tests/frame-source.test.ts` |
| 声明 `alpha` 时随 `FrameHostInfo.alpha` 交给宿主，不声明则不带这个键 | 宿主收到的信息里该键存在/不存在 | `tests/alpha-frames.test.ts`「声明 alpha 时随 FrameHostInfo 交给宿主」 |
| 合成宿主把 alpha 转成合成器 `begin` 的参数，显式 `options.alpha` 优先 | 合成器 begin 收到的 alpha 取值 | `tests/alpha-frames.test.ts`「合成宿主把 alpha 交给合成器的 begin」 |
| Canvas2D 合成器按 alpha 档创建上下文（建场时定死，不是每帧切换） | 上下文创建参数随声明变化 | `tests/alpha-frames.test.ts`「Canvas2D 合成器按 alpha 档创建上下文」 |
| 回读宿主把句柄转成位图；本来就是位图的原样交出（不复制） | 像素一致、位图路径的回读次数为 0 | `tests/readback-host.test.ts` |
| 回读宿主包装带生命周期的宿主时，`begin`/`close` 原样透传 | 内层的 begin/close 各被调用一次 | `tests/readback-host.test.ts` |
| 设备句柄不是 2D 画布 → 回读明确报错，不交黑帧 | 抛出指明替代路径的错误 | `tests/readback-host.test.ts` |
| 句柄载体贴到目标画布，位图载体走 `putImageData` | 两条路的落点不同、内容一致 | `tests/preview-blit.test.ts` |
| 剧本声明了层而宿主没给面对应的面 → 明确报错，不静默少画一层 | 渲染以错误结束 | `tests/layers-decl.test.ts` |
| 只注入 `painter`、不给 `canvas`、不开 `headless` 也能出帧 | 渲染成功且像素只由 `painter` 决定 | `tests/backend-port.test.ts` |

## 用法

最省事的形态是纯函数来源：给它帧号与时间戳，还一个位图。

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";
import type { FrameBitmap } from "@lingfan-video/contracts";

const W = 320;
const H = 180;

const scene = start(300, (env) => {
  env.step(300, () => {
    /* 这里只读状态，不直接画像素 */
  });
});

const painter = (): FrameBitmap => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 30; // R
    data[i + 1] = 90; // G
    data[i + 2] = 200; // B
    data[i + 3] = 255; // A，每通道 8 位
  }
  return { data, width: W, height: H };
};

await render(scene, {
  fps: 30,
  width: W,
  height: H,
  painter,
  exporter: new FrameSequenceExporter(),
});
```

需要跨帧保存状态（GPU 上下文、离屏画布）时用带生命周期的宿主：`begin` 里建、`frame` 里画、`close` 里拆。

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";
import type {
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  Ms,
} from "@lingfan-video/contracts";

const W = 320;
const H = 180;

class OffscreenHost implements FrameHost {
  private surface: Uint8ClampedArray | undefined;

  begin(info: FrameHostInfo): void {
    this.surface = new Uint8ClampedArray(W * H * 4); // 每次推演重建，重播即重置
    void info; // info.fps 帧/秒、width / height 像素、durationMs 毫秒、headless、layers
  }

  frame(_frame: FrameIndex, timestampMs: Ms): FrameCarrier {
    // timestampMs 是采样网格点的真实时间（毫秒），不是帧号的均匀倍数
    void timestampMs;
    return { data: this.surface ?? new Uint8ClampedArray(W * H * 4), width: W, height: H };
  }

  close(): void {
    this.surface = undefined; // 这里释放 GPU 上下文或离屏画布；推演成功或失败都会走到这里
  }
}

const host = new OffscreenHost();

const scene = start(200, (env) => {
  env.step(200, () => {});
});

await render(scene, {
  fps: 30,
  width: W,
  height: H,
  painter: host,
  exporter: new FrameSequenceExporter(),
});
```

自己接一条交付链：实现 `FrameSink`，按帧号与时间戳收帧。

```ts
import type { FrameSink, FrameIndex, FrameCarrier, Ms } from "@lingfan-video/contracts";

class CountingSink implements FrameSink {
  readonly times: Ms[] = [];

  async writeFrame(_frame: FrameCarrier, index: FrameIndex, timestampMs: Ms): Promise<void> {
    void index;
    this.times.push(timestampMs);
  }

  async finalize(): Promise<void> {
    // 全部帧交完后调用一次
  }
}

const sink = new CountingSink();
void sink;
```

要逐像素产物时，把交句柄的帧来源包一层回读宿主——回读发生在帧来源这一侧，导出器保持「只编码、不回读」。

```ts
import { render } from "@lingfan-video/core";
import { ApngExporter, createCompositeHost, createReadbackHost } from "@lingfan-video/infra";

// 合成宿主交的是设备句柄；APNG 要逐像素，所以在装配时声明要位图
const base = document.createElement("canvas"); // 剧本回调往这块画布上画
base.width = W;
base.height = H;
const composited = createCompositeHost({ base, width: W, height: H });
const painter = createReadbackHost(composited); // begin / close 原样透传给 composited

await render(scene, {
  fps: 25,
  width: W,
  height: H,
  alpha: "alpha",
  painter,
  exporter: new ApngExporter({ width: W, height: H }),
});
```

## 反例

- ✗ 写法：在 `FrameHost` 里写 `begin() {}` 空实现，把上下文缓存在模块级变量里复用 —— 为什么错：`begin` 是一次推演的起点，重播会再调一次；跨推演沿用的状态会让第二次推演出与第一次不同的画面；✓ 改成：状态在 `begin` 里创建、在 `close` 里释放。
- ✗ 写法：`writeFrame` 里把收到的 `FrameHandle` 存进数组，等循环结束再统一处理 —— 为什么错：句柄所有权随 `writeFrame` 一起转移，`writeFrame` 返回后引擎立即释放它，跨帧持有会拿到已释放的对象；✓ 改成：在 `writeFrame` 内消费完，需要保留就自己 `clone()`。
- ✗ 写法：异步取帧里让两次取帧并行，谁先回来先交 —— 为什么错：引擎要求逐帧等待、不得并发重入，并行会让帧序与采样网格错位；✓ 改成：串行，返回 Promise 让引擎等这一帧。
- ✗ 写法：`close()` 里抛错试图「报告关闭异常」并顺带清空已交帧 —— 为什么错：错误会交回调用方，但已交的帧不受影响也不该被回滚；✓ 改成：`close` 只管释放，错误让它自然上抛。
- ✗ 写法：给 `painter` 返回 `{ kind: "handle", native, width, height }` 却在导出端用只收 CPU 位图的导出器 —— 为什么错：句柄不承诺 CPU 可读，`FrameSequenceExporter` 会明确拒绝并提示改用编码导出器；✓ 改成：要么返回位图，要么换 `WebCodecsExporter`。

## 边界与陷阱

- `FrameBitmap.data`：RGBA 交错、每通道 8 位的 `Uint8ClampedArray`，长度必须等于 `width × height × 4`；长度不符在写帧前就报 `spec_violation`。
- `FrameBitmap.kind`：可省略；省略即按位图处理。位图数据在 CPU 侧可读写，需要纹理时由上层自行适配。
- `FrameHandle`：`kind` 为 `"handle"`，`native` 不透明（WebCodecs `VideoFrame`、GPU 纹理、离屏画布皆可）；只承诺同一设备内的消费端能把它作为一帧编码或合成，不承诺 CPU 可读。
- `FrameHandle.close()`：一个句柄只能调用一次，重复释放是使用方错误。所有权在 `writeFrame` 时转移，接收端要异步保留必须自己 `clone()`。
- `FrameSink.writeFrame` 的 `index`：帧号；变帧率下 `index → timestamp` 不是均匀映射，`timestampMs` 直出采样网格点（毫秒），不要用 `index × 帧长` 反推。
- `FrameSink.finalize`：全部帧交完后调用一次。
- `FrameSource`：同步返回载体或返回 Promise 均可。返回 Promise 是因为部分宿主没有同步抓帧能力；引擎会等这个 Promise 再交帧，所以异步宿主既不挤掉帧，也不会读到上一帧的半成品。
- `FrameHost.begin`：每次推演开始时调用一次（重播即重置）。之后按时间线顺序逐帧调 `frame`，引擎逐帧等待、不得并发重入。
- `FrameHost.close`：推演结束（成功或失败）后调用，可不实现。`begin` 失败时不会再调 `close`。
- `FrameHost.frame` 返回的位图由引擎复制或编码，宿主可以复用同一块缓冲；返回句柄则按 `FrameHandle` 所有权交给引擎释放。
- `FrameHostInfo.durationMs`：整片时长（毫秒）。`fps` 是帧/秒，`width` / `height` 是像素。
- `FrameHostInfo.headless`：本次是否无呈现推演。
- `FrameHostInfo.alpha`：本次推演要求的输出透明度，取自 `RenderOptions.alpha`；省略 = `"opaque"`。它不是渲染技巧而是画布语义：`"opaque"` 每帧从不透明黑开始、未覆盖处 alpha 恒 255；`"alpha"` 每帧从全透明开始、未覆盖处保持透明。宿主据此决定合成器建场时用哪种「干净」画布——上下文/设备的 alpha 能力在创建时定死，所以它是 `begin` 参数而不是每帧参数。
- 两档的共同不变量：每帧从干净画布开始，输出与上一帧无关。透明档只是把「干净」定义成全透明，不是「不清屏」。
- 要逐像素产物（APNG、自己的落盘）而合成器交的是句柄时，用 `createReadbackHost(inner)` 把帧来源包一层：它在帧来源这一侧完成回读，生命周期 `begin` / `close` 原样透传给内层。回读只对 2D 画布可行，GPU 设备与原生窗口拿不到 `getImageData`，这时明确报错而不是交黑帧。
- `FrameHostInfo.layers`：剧本层声明的编译产物，时刻是绝对故事时间；缺省 = 无声明。宿主按 `id` 配对，剧本声明了层而宿主没给面对应的面 → 明确报错，不静默少画一层。
- `Painter` 的两种形态由引擎判别：函数视为纯来源，带 `begin` / `frame` / `close` 的对象视为宿主。
- 缺省路径：不给 `painter` 时从绘制目标画布的 2D 上下文回读；既无 `painter` 又无 2D 上下文时按 `frames` 取值决定报错还是交占位位图（缺省 `"required"` = 报错）。
- 代价：一次 1280 × 720 的 `getImageData` 读数倍于一次绘制，所以能走句柄就不回读。
- 确定性前提：位图路径逐字节可比；句柄路径的可比性取决于设备与消费端。

## 相关

- 端口源码：`packages/contracts/src/capture/ports.ts`
- 入口选项：`packages/contracts/src/entry/ports.ts`（`painter`、`frames`、`headless`）
- 相邻页：`docs/contracts/export.md`、`docs/contracts/scheduler.md`、`docs/contracts/index.md`
