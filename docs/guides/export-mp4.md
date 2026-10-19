# 在浏览器里出片：帧 → 音轨 → mp4

`WebCodecsExporter`（`packages/infra/src/export/webcodecs/`）实现 `Exporter` 端口（`packages/contracts/src/export/ports.ts`），把推演交出的帧编码成 H.264、把 `AudioClock` 混出的 PCM 编码成 AAC，再由 `Mp4Muxer` 封装成 `Blob`。

## 何时用 / 何时不用

- **用**：要在浏览器里拿到一个可下载的 mp4；需要音轨进片子；需要控制码率或分辨率。
- **不用**：只想看画面 → 预览路径（`PacedPreviewExporter` + `CanvasBlitExporter`）；只想拿到像素数组 → `FrameSequenceExporter`，它不引入编码器；只想验证不推演 → `debug-with-compute.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 顺序固定：帧全部写完 → 写音频块 → finalize | 调用序列为 `["frames","audio","finalize"]` | `tests/export-audio.test.ts`「帧全部写完后才写音频块，音频写完才 finalize」 |
| 无声音时不调用 `writeAudio`，纯视频导出仍成立 | 调用序列为 `["frames","finalize"]` | `tests/export-audio.test.ts`「无声音时不调用 writeAudio（纯视频导出）」 |
| 有声音、导出器不支持音轨 → `spec_violation`，不静默丢音 | 抛错文案指明导出器 `impl` | `tests/export-audio.test.ts`「有声音但导出器不支持音轨 → spec_violation」 |
| 有声音、有音轨出口、但没注入 `AudioClock` → `spec_violation` | 抛错文案要求给出混音时钟 | `tests/export-audio.test.ts`「有声音但没有 AudioClock → spec_violation」 |
| 位图尺寸与导出尺寸不一致：写帧前就报错 | `writeFrame` 抛 `spec_violation` | `tests/webcodecs-exporter.test.ts`「尺寸与导出尺寸不一致：写帧前报 spec_violation」 |
| 位图数据长度不符：写帧前就报错 | `writeFrame` 抛 `spec_violation` | `tests/webcodecs-exporter.test.ts`「位图数据长度不符：写帧前报 spec_violation」 |
| 编码器报错后，后续写入按同一错误失败，不静默继续 | 同一错误重复抛出 | `tests/webcodecs-exporter.test.ts`「error 回调之后：后续写入按同一错误失败，而不是静默继续」 |
| 音频块声道布局由首块定下，之后的坏块不污染布局 | 坏块不占位，后续单声道块正常写入 | `tests/webcodecs-exporter.test.ts`「样本数不是声道整数倍的坏块不占布局：之后单声道块正常写入」 |
| 收尾失败不锁死实例，可重试 | 同一实例再次 `finalize` 成功 | `tests/webcodecs-exporter.test.ts`「收尾失败后同一实例仍可再次收尾与写入」 |
| 不注入 `painter`、不给 2D 画布又不开 `headless` → 首帧 `spec_violation`，不静默交白帧 | 报错文案要求注入 painter 或声明 `allow-blank` | `tests/frame-source.test.ts`「无 painter 且无 2D 上下文 → spec_violation（不静默交空白帧）」 |
| 容器结构可解析：纯视频 `ftyp → moov → mdat`，带音轨两个 `trak` | 解析出对应 box 序列 | `tests/mp4-muxer.test.ts`「纯视频：ftyp → moov → mdat」「带音轨：两个 trak」 |

## 用法

### 最小可用出片

```ts
import { render } from "@lingfan-video/core";
import { WebCodecsExporter } from "@lingfan-video/infra";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
  throw new Error("当前浏览器不支持 WebCodecs 编码（需要 Chrome/Edge 94+）");
}

// 导出用一块独立画布：预览画布上留着上一帧与 2D 状态，
// 复用会让「先预览再导出」与「直接导出」得到不同像素。
const exportCanvas = document.createElement("canvas");
const host = makeStageHost(exportCanvas, true, WIDTH, HEIGHT); // 见下节
const exporter = new WebCodecsExporter({ width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 7_000_000 });

const result = await render(program.picture, {
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
  canvas: exportCanvas,
  exporter,
  headless: false,
  painter: host,
  onProgress: (done) => console.log(`已交帧 ${done}`),
});

const blob = result.output.output;
if (!(blob instanceof Blob)) throw new Error("导出器未返回 Blob");
const url = URL.createObjectURL(blob);
// 用完后 60_000ms 撤销
window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
```

`frames` 两个取值的差别：

| `frames` | 缺省？ | 行为 |
| --- | --- | --- |
| `"required"` | **是** | 既无 `painter` 又无 2D 画布上下文 → 首帧即 `spec_violation`。适合出片：宁可报错也不交白帧 |
| `"allow-blank"` | 否 | 接受全 0 占位位图。适合预览或宿主自绘的 sink。**不豁免回读**：仍会每帧从画布回读整幅像素 |

出片用 `"required"`（即省略不写）并确保 `painter` 或可 2D 的 `canvas` 至少有一个。

### 音频时钟

`AudioClock` 是导出端的混音端口。缺省**不注入** = 纯视频导出；注入了才写音轨。

```ts
import { OfflineAudioMixer } from "@lingfan-video/infra";

const audio = new OfflineAudioMixer(makeSynthDecoder(48_000), { sampleRate: 48_000, channels: 2 });
await render(program.picture, { fps: FPS, width: WIDTH, height: HEIGHT, canvas: exportCanvas, exporter, audio, headless: false, painter: host });
```

- `sampleRate` 缺省 48000Hz，`channels` 缺省 2。
- `renderProgram(program)` 返回从 0ms 起的单段交错 Float32 样本；同一程序重复调用逐样本一致。
- 样本是时间线的纯函数，与帧率无关；所以改 `fps` 不会改声音。

### `canvas` 与 `painter` 的分工

两者解决不同问题，缺一会走不同的兜底：

- `painter`（`FrameSource | FrameHost`）：**直接交帧**。给了它引擎就不回读绘制目标，像素只由它决定。合成宿主（`createCompositeHost`）走这条：它按层声明把底图与各层的面叠成一张 `FrameHandle` 或位图。
- `canvas`：绘制目标。没给 `painter` 时，引擎从这个画布的 2D 上下文回读像素；`canvas` 与 `painter` 都不给且不开 `headless` 时才落到「没有帧来源」的报错。

浏览器出片的典型装配是**两个都给**：`canvas` 当绘制目标，`painter` 是合成宿主（它自己也可能画到这块画布上）。用 `createCompositeHost` 时注意 GPU 档交的是设备句柄，必须让导出器能零拷贝吃下 `VideoFrame`；交位图的路径会让 `WebCodecsExporter` 走 CPU 上传，慢但仍正确。

### 帧 → 音轨 → finalize 的次序

这个次序由组合根固定，不可重排：

1. `engine.run` 逐帧交帧，导出器逐帧 `writeFrame`（内部 `await drain()` 做背压）。
2. 帧全部交完后，`writeAudioTrack` 调 `AudioClock.renderProgram`，把样本按块交给 `writeAudio`。
3. 最后 `exporter.finalize()`：冲刷编码器、取 AVC 参数集、封装 mp4、返回 `ExportResult`。

违反次序会被明确挡住：无帧就 `finalize` 抛「无已编码帧（finalize 前需 writeFrame）」；`finalize` 之后再写抛 `spec_violation`，说的是「finalize 之后不能再写入」。

## 反例

✗ **预览画布复用为导出画布**

> 伪代码

```ts
await render(picture, { canvas: previewCanvas, painter: previewHost, exporter });
```

为什么错：预览画布上留着上一次播放的最后一帧与 2D 状态，复用会让「先预览再导出」和「直接导出」得到不同像素，跨设备比对直接失效。

✓ 每次导出新建一块画布与对应的宿主：

> 伪代码

```ts
const exportCanvas = document.createElement("canvas");
const host = makeStageHost(exportCanvas, true, WIDTH, HEIGHT);
```

✗ **给了 `canvas` 就以为出片一定对**

> 伪代码

```ts
await render(picture, { canvas, exporter }); // 缺 painter，也未开 headless
```

为什么错：能回读不等于回读到想要的像素。没注入 `painter` 时引擎从 `canvas.getContext("2d")` 回读——Node 下通常没有 2D 上下文，直接首帧 `spec_violation`；浏览器里则可能回读到一块没被画过的画布。

✓ 显式注入 `painter`：

> 伪代码

```ts
await render(picture, { canvas, painter: host, exporter });
```

✗ **只想拿像素却用 `WebCodecsExporter`**

为什么错：它是编码器适配器，成本在编码与封装，而且依赖浏览器能力探测。要像素数组用 `FrameSequenceExporter`（`frames` / `timestamps` 两个 getter 直接给出）。

## 边界与陷阱

- **能力探测必须做**：`VideoEncoder` / `AudioEncoder` 任一缺失时构造编码器会失败，先探测再走导出分支。
- **`fps` 只是编码器提示**：真实时间戳来自帧本身（`Math.round(timestampMs * 1000)` 微秒）。首帧时长取 `1000000/fps` 微秒，其后取相邻时间戳之差；所以变帧率剧本不会被抹平。
- **关键帧间隔固定**：每 60 帧一个关键帧，不可配。
- **`bitrate` 缺省 8Mbps，`audioBitrate` 缺省 128kbps**。画面大面积暗部时 7Mbps 足够，再高只是把文件撑大。
- **`writeFrame` 不可并发**：内部 `drain()` 是背压，队列上限 `MAX_ENCODE_QUEUE = 16`，超了就在 `writeFrame` 上等。
- **`writeAudio` 的声道布局由首块定死**：后续块与首块不一致会抛 `spec_violation`；单块上限 `AUDIO_BLOCK_FRAMES = 4096` 采样帧，内部自动切块并转 `f32-planar`。
- **`WebCodecsExporter` 只接两种帧载体**：CPU 位图与设备句柄。`FrameHandle` 的所有权随 `writeFrame` 转移，接收端要异步保留必须自己 `clone()`。
- **确定性是分级的**：CPU 2D 路径承诺跨设备逐字节相同；GPU / 第三方框架只承诺同设备、同代码、同数据相同。做跨设备比对前先确认走的是哪一级。
- **`finalize` 不幂等**：成功后重复调用会抛 `spec_violation`；封装阶段失败时 `finalized` 不置位，同一实例可重试。
- **长片不要用 `FrameSequenceExporter`**：像素全留在内存里，内存随帧数线性增长。

## 相关

- 端口源码：`packages/contracts/src/export/ports.ts`（`Exporter` / `ExportResult` / `ExportFormat` / `ExporterImpl`）、`packages/contracts/src/capture/ports.ts`（`FrameCarrier` / `FrameBitmap` / `FrameHandle` / `Painter`）、`packages/contracts/src/entry/ports.ts`（`RenderOptions` / `RenderResult`）、`packages/contracts/src/audio/ports.ts`（`AudioClock` / `AudioOutput`）；实现见 `packages/infra/src/export/webcodecs/`（`exporter.ts` / `video-track.ts` / `audio-track.ts` / `encoder-gate.ts` / `types.ts`）、`packages/infra/src/export/frame-sequence-exporter.ts`、`packages/infra/src/audio/offline-mixer.ts`、`packages/infra/src/frames/composite-host.ts`。
- 示例：`examples/browser/export.ts`（能力探测 + 独立画布 + 音频时钟 + Blob 下载）、`examples/browser/host.ts`（预览 CPU 档与导出 GPU 档两套合成器）。
- 相邻页：`compose-acts.md`（多幕与重叠窗）、`add-audio.md`（声音登记与总线）、`debug-with-compute.md`（不整片出片的验证手段）、`first-clip.md`（单幕入口）。
