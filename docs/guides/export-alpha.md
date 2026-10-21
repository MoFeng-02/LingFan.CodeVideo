# 出透明产物：声明画布 → 逐像素封装

透明帧不是「导出时多开一个开关」，它是**这一趟推演要交出哪种画布**的声明：`RenderOptions.alpha`。声明之后，这条链路每一环各做一件事——合成器按声明建场、帧来源按声明交位图、导出器按声明选封装。三者任一处对不上，产物就不透明，而且往往不报错，只是黑底。

这篇讲三段：怎么声明、为什么必须逐像素、以及哪些封装装得下 alpha。装得下 alpha 的有两支：`ApngExporter` 交单文件动图（无音轨），`WebmExporter` 交带音轨的成片（VP8/VP9 颜色轨 + 一条只含关键帧的 alpha 侧通道）。

## 何时用 / 何时不用

- **用**：产物要叠在别人的画面上当素材（片头、贴片、角色动画），因为留白处必须真透明而不是黑。
- **用**：要给剪辑软件或设计工具一份能直接拖进去的动图，因为 `ApngExporter` 交单文件、逐帧保 alpha。
- **用**：要**带音轨的透明成片**（透明片头配解说、透明动画带音效），因为 `WebmExporter` 是唯一同时装得下 Opus 音轨与 alpha 侧通道的适配器。
- **用**：自己要拿 RGBA 做再加工，因为 `alpha: "alpha"` + `FrameSequenceExporter` 给出未被改写的原始通道。
- **不用**：成片是最终交付、会被铺满整屏，那就用 `"opaque"` 出 mp4——H.264 结构上没有 alpha，声明透明只会得到一份被填黑的产物。
- **不用**：只想验证画面对不对，因为透明与否不影响 `compute` 的状态取样，用 `debug-with-compute.md` 更便宜。

## 断言表

| 断言                                                                 | 判据                                            | 钉子                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 声明 `alpha` 时随 `FrameHostInfo.alpha` 交给宿主，不声明则不带这个键 | 宿主收到的信息里该键存在/不存在                 | `tests/alpha-frames.test.ts`「声明 alpha 时随 FrameHostInfo 交给宿主；不声明则不带这个键」   |
| 合成宿主把声明转成合成器 `begin` 的参数，显式 `options.alpha` 优先   | 合成器 `begin` 收到的 alpha 取值                | `tests/alpha-frames.test.ts`「合成宿主把 alpha 交给合成器的 begin，显式 options.alpha 优先」 |
| Canvas2D 合成器按 alpha 档创建上下文（建场时定死，不是每帧切换）     | 上下文创建参数随声明变化                        | `tests/alpha-frames.test.ts`「Canvas2D 合成器按 alpha 档创建上下文」                         |
| 声明透明却配 mp4 封装 → 首帧前 `spec_violation`，一帧都不写          | 报错文案指明 H.264 无 alpha 通道、导出器收 0 帧 | `tests/alpha-frames.test.ts`「声明 \"alpha\" 却用 mp4 封装：首帧前报错，且不写任何帧」       |
| 不声明透明时 mp4 照常放行                                            | 渲染正常完成、帧数等于推演帧数                  | `tests/alpha-frames.test.ts`「不声明透明时 mp4 照常放行」                                    |
| APNG 产物逐字节保留 alpha 通道                                       | 解压后每行过滤字节为 0、像素 alpha 与输入一致   | `tests/apng-exporter.test.ts`「alpha 通道逐字节落进产物」                                    |
| APNG 停留时长取相邻时间戳差，变帧率不被抹平                          | fcTL 的 delay 序列等于各段间隔                  | `tests/apng-exporter.test.ts`「停留时长按相邻时间戳差表达，末帧沿用前一间隔」                |
| 回读宿主把句柄转成位图；本来就是位图的不复制                         | 像素一致、位图路径不回读                        | `tests/readback-host.test.ts`「位图载体原样交出（不复制、不回读）」                          |
| 设备句柄不是 2D 画布 → 回读明确报错，不交黑帧                        | 抛出指明替代路径的错误                          | `tests/readback-host.test.ts`「非 2D 设备明确报错，而不是交一张黑帧」                        |
| 同一组输入两次封装字节完全相同                                       | 两次 `fileBytes` 逐字节相等                     | `tests/apng-exporter.test.ts`「同一组输入两次封装得到完全相同的字节」                        |
| 透明 webm 在轨道上声明 AlphaMode，块走 BlockGroup 带 alpha 平面      | 轨道元素出现 AlphaMode、块带附加数据            | `tests/webm-muxer.test.ts`「透明档在轨道上声明 AlphaMode」                                   |
| 透明 webm 多开一路编码器，把 alpha 铺进 RGB 三通道                   | 第二路编码器的输入每像素三通道等于原 alpha      | `tests/webm-exporter.test.ts`「多开一个编码器，把 alpha 铺进 RGB 三通道」                    |
| 透明档只收位图：设备句柄明确报错，不回读像素                         | 写入以 `spec_violation` 失败                    | `tests/webm-exporter.test.ts`「透明档只收位图：设备句柄明确报错」                            |
| 实例的 alpha 能力如实报告给引擎（入口声明与产物能力对账）            | 实例的 `alpha` 字段与构造参数一致               | `tests/webm-exporter.test.ts`「声明 transparent 的实例把能力如实报告给引擎」                 |
| 两路编码块配齐才交给容器，收尾没有残留                               | 收尾后容器里的块数等于帧数                      | `tests/webm-exporter.test.ts`「两路编码块配齐才交给容器：收尾时没有残留」                    |

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

### 带音轨的透明成片：两处都要声明

`WebmExporter` 的 alpha 不是封装自带的性质，而是一条**并行的侧通道**：颜色轨照常编 VP8/VP9，另开一路编码器把逐像素 alpha 铺进一个灰度画面的三个通道，容器里落在 `BlockAdditions`。所以声明要在两处给——入口声明这一趟要透明画布，导出器实例声明这份产物装得下 alpha。

```ts
import { render } from "@lingfan-video/core";
import { WebmExporter } from "@lingfan-video/infra";

await render(scene, {
  fps: 30,
  width: 1280,
  height: 720,
  alpha: "alpha", // 入口：这一趟要透明画布
  painter, // 帧来源必须交位图（透明档不回读句柄）
  audio, // Opus 音轨用的混音时钟
  exporter: new WebmExporter({
    width: 1280,
    height: 720,
    fps: 30,
    alpha: true, // 实例：这份产物装得下 alpha
  }),
});
```

两处少给一处都不行：只给入口，导出器按缺省建不带 alpha 的实例，产物是不透明的；只给实例，合成器仍从一把不透明画布开始，alpha 通道在这一步就丢了。

用文件探针看这份产物，像素格式是普通 yuv——**这不代表没有 alpha**，alpha 在侧通道里。判据看容器：轨道上有没有 `AlphaMode`、块是不是 `BlockGroup` 带附加数据。

### 四档导出器怎么选

| 导出器                  | 产物                   | 保 alpha                | 音轨   | 代价                                 |
| ----------------------- | ---------------------- | ----------------------- | ------ | ------------------------------------ |
| `ApngExporter`          | 单文件动图             | 是                      | 无     | 每帧压一遍扫描线，内存随帧数线性增长 |
| `WebmExporter`          | webm（VP8/VP9 + Opus） | 声明 `alpha: true` 才保 | 有     | 颜色 + alpha 两路编码，耗时按两路算  |
| `FrameSequenceExporter` | 逐帧原始 RGBA + 元数据 | 是                      | 无     | 像素全留内存；不落成单个视频文件     |
| `WebCodecsExporter`     | mp4（H.264 / AAC）     | 否                      | 有     | 声明透明会被首帧守卫拦下             |
| 自定义 `Exporter`       | 你说的算               | 看封装与实例声明        | 看实现 | 自己实现 `writeFrame` / `finalize`   |

两条透明路径的完整装配在示例里：`examples/browser/export-alpha.ts`（同一个 `render` 调两次，只换导出器与封装声明）、`examples/browser/export-ui.ts`（三条出片路径共用一份互斥与下载），演示片段见 `examples/browser/ledger/demo.ts`——它取整片开头几镜单独成片，因为 APNG 的内存随帧数线性增长，整片一次性出不划算。

## 反例

### ✗ 声明透明却配 mp4 导出器

```ts
await render(scene, { alpha: "alpha", exporter: new WebCodecsExporter({ ... }) });
// SpecViolation：H.264 没有 alpha 通道，透明区域会被填成黑底
```

为什么错：产物能不能带 alpha 是**封装**的性质，不是导出器的努力程度。H.264 结构上没有 alpha 通道，带透明的画面进去只会得到一片黑底——一份看起来成功、实际透明全被填黑的产物比报错更坏。首帧前守卫就是为这件事存在的。

✓ 换成能装下 alpha 的封装：

```ts
await render(scene, {
  alpha: "alpha",
  exporter: new ApngExporter({ width: W, height: H }),
});
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
- **两处声明才成立**：入口的 `RenderOptions.alpha` 说的是「这一趟要哪种画布」，导出器实例的 `Exporter.alpha` 说的是「这份产物装得下 alpha」。守卫拿两者对账，对不上在首帧前就拦。
- **守卫只管对不上的那一侧**：`frames` 与 `apng` 恒保 alpha；`webm` 的 alpha 由实例的 `alpha: true` 决定，没声明就按不透明放行；`mp4` 结构上没有 alpha，声明透明会被拦。
- **透明 webm 是两路编码**：颜色轨 + 一条只含关键帧的 alpha 侧通道，按时间戳配对，配不齐在收尾时明确报错。耗时与码率都要按两路算（`alphaBitrate` 单列）。
- **文件探针看不到 alpha**：透明 webm 的像素格式仍是普通 yuv，alpha 在 `BlockAdditions` 里。要判产物是否真透明，看轨道的 `AlphaMode` 与块结构，别信探针的像素格式。
- **WebM 音频固定 48kHz**：Opus 的采样率写在码流头里，48kHz 之外在首块即报 `spec_violation`，不做静默重采样（静默改采样率会让音高整体偏掉）。
- **APNG 没有音轨**：有声音的剧本会给 `writeAudio` 报错，而不是静默丢音轨。要带声音的透明成片用 `WebmExporter`。
- **APNG 只收 CPU 位图**：收到 `FrameHandle` 即明确报错；尺寸与声明不符也在写帧前拦下。透明 webm 同样只收位图。
- **预览不受影响**：`CanvasBlitExporter` / `PacedPreviewExporter` 只负责贴到目标画布、按主时钟放行，`impl` / `format` 照抄内层，不感知 alpha。
- **画面里的不透明底会把 alpha 填死**：声明再对、封装再保 alpha，只要某一层铺了整幅不透明底（做片时用来压暗背景的那种遮罩），产物就是一张满 alpha 的画面。透明产物是素材，得按素材重新决定「哪些底色要留」——这不是引擎的事，是场景的事。
- **确定性分级**：APNG 是纯内存封装、无编码器参与，同一组输入两次封装字节完全相同；mp4 与 webm 两路受编码器与容器影响，比对用帧指纹而不是比较文件字节。

## 相关

- 端口源码：`packages/contracts/src/entry/ports.ts`（`RenderOptions.alpha`）、`packages/contracts/src/capture/ports.ts`（`FrameAlpha` / `FrameHostInfo.alpha` / `FrameBitmap`）、`packages/contracts/src/export/ports.ts`（`ExportFormat` / `ExporterImpl` / `Exporter.alpha`）。
- 实现：`packages/infra/src/frames/canvas2d-compositor.ts`、`packages/infra/src/frames/adapters/three-compositor.ts`、`packages/infra/src/frames/composite-host.ts`、`packages/infra/src/frames/readback-host.ts`、`packages/infra/src/export/png/`（`png.ts` / `apng-chunks.ts` / `apng-exporter.ts` / `crc32.ts`）、`packages/infra/src/export/webm/`（`ebml.ts` / `blocks.ts` / `webm-muxer.ts` / `video-track.ts` / `audio-track.ts` / `exporter.ts`）。
- 相邻页：`export-mp4.md`（不透明成片与编码器装配）、`docs/contracts/capture.md`（帧载体与宿主生命周期）、`docs/contracts/export.md`（导出端口与产物语义）、`docs/glossary.md`（透明度声明、回读宿主、产物 alpha 能力、alpha 侧通道）。
