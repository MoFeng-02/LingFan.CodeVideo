# 出透明产物：声明画布 → 逐像素封装

透明帧不是「导出时多开一个开关」，它是**这一趟推演要交出哪种画布**的声明：`RenderOptions.alpha`。声明之后，这条链路每一环各做一件事——合成器按声明建场、帧来源按声明交位图、导出器按声明选封装。三者任一处对不上，产物就不透明，而且往往不报错，只是黑底。

这篇讲三段：怎么声明、为什么必须逐像素、以及哪些封装装得下 alpha。

## 何时用 / 何时不用

- **用**：产物要叠在别人的画面上当素材（片头、贴片、角色动画），因为留白处必须真透明而不是黑。
- **用**：要给剪辑软件或设计工具一份能直接拖进去的动图，因为 `ApngExporter` 交单文件、逐帧保 alpha。
- **用**：自己要拿 RGBA 做再加工，因为 `alpha: "alpha"` + `FrameSequenceExporter` 给出未被改写的原始通道。
- **不用**：成片是最终交付、会被铺满整屏，那就用 `"opaque"` 出 mp4——H.264 结构上没有 alpha，声明透明只会得到一份被填黑的产物。
- **不用**：只想验证画面对不对，因为透明与否不影响 `compute` 的状态取样，用 `debug-with-compute.md` 更便宜。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 声明 `alpha` 时随 `FrameHostInfo.alpha` 交给宿主，不声明则不带这个键 | 宿主收到的信息里该键存在/不存在 | `tests/alpha-frames.test.ts`「声明 alpha 时随 FrameHostInfo 交给宿主；不声明则不带这个键」 |
| 合成宿主把声明转成合成器 `begin` 的参数，显式 `options.alpha` 优先 | 合成器 `begin` 收到的 alpha 取值 | `tests/alpha-frames.test.ts`「合成宿主把 alpha 交给合成器的 begin，显式 options.alpha 优先」 |
| Canvas2D 合成器按 alpha 档创建上下文（建场时定死，不是每帧切换） | 上下文创建参数随声明变化 | `tests/alpha-frames.test.ts`「Canvas2D 合成器按 alpha 档创建上下文」 |
| 声明透明却配 mp4 封装 → 首帧前 `spec_violation`，一帧都不写 | 报错文案指明 H.264 无 alpha 通道、导出器收 0 帧 | `tests/alpha-frames.test.ts`「声明 \"alpha\" 却用 mp4 封装：首帧前报错，且不写任何帧」 |
| 不声明透明时 mp4 照常放行 | 渲染正常完成、帧数等于推演帧数 | `tests/alpha-frames.test.ts`「不声明透明时 mp4 照常放行」 |
| APNG 产物逐字节保留 alpha 通道 | 解压后每行过滤字节为 0、像素 alpha 与输入一致 | `tests/apng-exporter.test.ts`「alpha 通道逐字节落进产物」 |
| APNG 停留时长取相邻时间戳差，变帧率不被抹平 | fcTL 的 delay 序列等于各段间隔 | `tests/apng-exporter.test.ts`「停留时长按相邻时间戳差表达，末帧沿用前一间隔」 |
| 回读宿主把句柄转成位图；本来就是位图的不复制 | 像素一致、位图路径不回读 | `tests/readback-host.test.ts`「位图载体原样交出（不复制、不回读）」 |
| 设备句柄不是 2D 画布 → 回读明确报错，不交黑帧 | 抛出指明替代路径的错误 | `tests/readback-host.test.ts`「非 2D 设备明确报错，而不是交一张黑帧」 |
| 同一组输入两次封装字节完全相同 | 两次 `fileBytes` 逐字节相等 | `tests/apng-exporter.test.ts`「同一组输入两次封装得到完全相同的字节」 |

## 用法

### 最小透明产物

三件事：声明 `alpha`、给一个交**位图**的帧来源、选一个装得下 alpha 的导出器。

```ts
import { render, start } from "@lingfan-video/core";
import { ApngExporter } from "@lingfan-video/infra";
import type { FrameBitmap } from "@lingfan-video/contracts";

const W = 320;
const H = 180;

const scene = start(400, (env) => {
  env.step(400, () => {
    /* 只画主体；四周留空 */
  });
});

// 位图路径：alpha 自己写，别默认填 255
const painter = (): FrameBitmap => {
  const data = new Uint8ClampedArray(W * H * 4); // 全 0 = 全透明
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 240; // R
    data[i + 1] = 120; // G
    data[i + 2] = 40; // B
    data[i + 3] = 255; // A：主体不透明，留白处保持 0
  }
  return { data, width: W, height: H };
};

const result = await render(scene, {
  fps: 25,
  width: W,
  height: H,
  alpha: "alpha", // 这一趟要的是透明画布
  painter,
  exporter: new ApngExporter({ width: W, height: H }),
});

void result.output.output; // Blob，type = "image/apng"
```

### 合成器交的是句柄，怎么拿到位图

`createCompositeHost` 交的是**设备侧句柄**——它不承诺 CPU 可读，所以透明产物要在装配时声明「我要位图」：用 `createReadbackHost` 把帧来源包一层。回读发生在帧来源这一侧，导出器保持「只编码、不回读」。

```ts
import { render } from "@lingfan-video/core";
import {
  ApngExporter,
  createCompositeHost,
  createReadbackHost,
} from "@lingfan-video/infra";

const W = 320;
const H = 180;
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

回读只在 2D 画布上可行。`createThreeCompositor` 这类 GPU 合成器交出的 `renderer.domElement` 拿不到 2D 上下文，回读会明确报错并指出替代路径——这不是缺陷，是「设备侧载体不承诺 CPU 可读」这条约定生效的地方。

### 「干净」是哪种干净

透明与不透明两档共享同一条不变量：**每帧都从干净画布开始，输出与上一帧无关**。差别只在「干净」的定义：

- `"opaque"`（缺省）：每帧从不透明黑开始，未覆盖处的 alpha 恒为 255。这是能直接交给 H.264 的那一档。
- `"alpha"`：每帧从全透明开始，未覆盖处保持 alpha = 0，逐像素带到导出端。

所以透明档**不是**「不清屏」。漏清会让上一帧的像素留成鬼影，输出就与上一帧有关了——那正是合成语义要排除的东西。

### 三档导出器怎么选

| 导出器 | 产物 | 保 alpha | 代价 |
| --- | --- | --- | --- |
| `ApngExporter` | 单文件动图 | 是 | 每帧压一遍扫描线，内存随帧数线性增长 |
| `FrameSequenceExporter` | 逐帧原始 RGBA + 元数据 | 是 | 像素全留内存；不落成单个视频文件 |
| `WebCodecsExporter` | mp4（H.264 / AAC） | 否 | 声明透明会被首帧守卫拦下 |
| 自定义 `Exporter` | 你说的算 | 看封装 | 自己实现 `writeFrame` / `finalize` |

## 反例

### ✗ 声明透明却配 mp4 导出器

```ts
await render(scene, { alpha: "alpha", exporter: new WebCodecsExporter({ ... }) });
// SpecViolation：H.264 没有 alpha 通道，透明区域会被填成黑底
```

为什么错：产物能不能带 alpha 是**封装**的性质，不是导出器的努力程度。H.264 结构上没有 alpha 通道，带透明的画面进去只会得到一片黑底——一份看起来成功、实际透明全被填黑的产物比报错更坏。首帧前守卫就是为这件事存在的。

✓ 换成能装下 alpha 的封装：

```ts
await render(scene, { alpha: "alpha", exporter: new ApngExporter({ width: W, height: H }) });
```

### ✗ 在导出器里写「拿不到位图就 `getImageData` 兜底」

为什么错：导出器回读会把编码降级成事后补救，还掩盖了「这台设备没有 2D 上下文」的装配错误——本来该在装配时报的错，变成一张全黑的成品。

✓ 在帧来源这一侧声明要位图：`createReadbackHost(inner)`。回读属于「我这一趟要交什么载体」的选择，不属于编码。

### ✗ 以为 `alpha: "alpha"` 会给合成器「自动清成透明」

为什么错：声明只是告诉宿主这一趟要哪种画布；每帧照样要清。透明档的「干净」是全透明，不是「什么都不做」。

✓ 合成器按声明建场、按不变量清屏；作者只管画主体，留白处自然透明。

### ✗ 长片一次性出 APNG

为什么错：每帧压好的扫描线要在内存里驻留到 `finalize`（`acTL` 要求提前声明总帧数，只有推演结束才知道），内存随帧数线性增长。

✓ 分段出，或改用逐帧位图自己落盘（`FrameSequenceExporter` 的 `frames` getter 逐帧给出）。

## 边界与陷阱

- **alpha 在建场时定死**：上下文/设备的 alpha 能力是创建参数，不是每帧参数，所以它走 `Compositor.begin` 而不是 `composite`。换档必须重新 `begin`。
- **声明可选**：`FrameHostInfo.alpha` 省略即 `"opaque"`。不给键而不是给 `"opaque"`，是为了让「没声明」与「显式声明不透明」在宿主侧可区分。
- **守卫只管对不上的那一侧**：`frames` 留下原始 RGBA、`apng` 逐帧保 alpha、`webm` 保不保取决于适配器选的编码，所以只有 mp4 会在首帧前被拦。
- **APNG 没有音轨**：有声音的剧本会给 `writeAudio` 报错，而不是静默丢音轨。要带声音的透明成片，本仓暂没有这样的适配器。
- **APNG 只收 CPU 位图**：收到 `FrameHandle` 即明确报错；尺寸与声明不符也在写帧前拦下。
- **预览不受影响**：`CanvasBlitExporter` / `PacedPreviewExporter` 只负责贴到目标画布、按主时钟放行，`impl` / `format` 照抄内层，不感知 alpha。
- **确定性分级**：APNG 是纯内存封装、无编码器参与，同一组输入两次封装字节完全相同；mp4 那一路受编码器与容器影响，比对用帧指纹而不是比较文件字节。

## 相关

- 端口源码：`packages/contracts/src/entry/ports.ts`（`RenderOptions.alpha`）、`packages/contracts/src/capture/ports.ts`（`FrameAlpha` / `FrameHostInfo.alpha` / `FrameBitmap`）、`packages/contracts/src/export/ports.ts`（`ExportFormat` / `ExporterImpl`）。
- 实现：`packages/infra/src/frames/canvas2d-compositor.ts`、`packages/infra/src/frames/adapters/three-compositor.ts`、`packages/infra/src/frames/composite-host.ts`、`packages/infra/src/frames/readback-host.ts`、`packages/infra/src/export/png/`（`png.ts` / `apng-chunks.ts` / `apng-exporter.ts` / `crc32.ts`）。
- 相邻页：`export-mp4.md`（不透明成片与编码器装配）、`docs/contracts/capture.md`（帧载体与宿主生命周期）、`docs/contracts/export.md`（导出端口与产物语义）、`docs/glossary.md`（透明度声明、回读宿主）。
