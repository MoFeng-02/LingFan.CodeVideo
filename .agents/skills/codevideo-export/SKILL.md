---
name: codevideo-export
description: 出片与预览：render 的完整流程、Exporter 五形态（frames / webcodecs / webm / apng / ffmpeg）、透明帧的声明与封装选择、帧到音轨到 finalize 的顺序、painter 与 canvas 的注入选择、帧载体所有权、PacedPreviewExporter + CanvasBlitExporter 的预览装配。Use when emitting an mp4 or a webm (with or without an alpha side channel), a transparent APNG, wiring preview, injecting a canvas or painter, choosing an alpha-capable container, or diagnosing missing-frame-source errors.
metadata:
  version: "2.1.0"
---

# 出片与预览

`render(scene, options)` 做四件事：建引擎 → 逐帧推演并把帧交给 `FrameSink` → 写音轨 → `finalize` 拿产物。顺序即封装顺序，不可调换。

## 何时用 / 何时不用

- 用：在浏览器出 mp4、接实时预览、注入画布或框架的 painter、排查「没有帧来源」「音轨缺失」类报错。
- 不用：只写剧本 → `codevideo-scene` / `codevideo-schedule`；只验证时间与画面 → `codevideo-verify`；只调声音 → `codevideo-audio`。

## API 面备查（签名以源码为准）

`RenderOptions`（`packages/contracts/src/entry/ports.ts`，唯一全量入口）：

| 字段 | 类型 / 缺省 | 要点 |
| --- | --- | --- |
| `fps` / `width` / `height` | 必填 | 采样密度与画幅；预览与导出必须同一份 |
| `exporter` | 必填 | 渲染后端，没有它就没有产物 |
| `canvas` | 可选 | 能 `getContext("2d")` 的画布 → 引擎走回读路径 |
| `painter` | 可选 | `FrameSource | FrameHost`（联合名 `Painter`）→ 宿主自绘像素 |
| `frames` | `"required"` | `"allow-blank"` 只豁免「没有帧来源」报错，不豁免回读 |
| `alpha` | `"opaque"` | 本次推演要哪种画布：`"alpha"` 让留白处真透明并逐像素带到导出端 |
| `audio` | 可选 | `AudioClock`（离线混音）→ 写进音轨 |
| `audioOutput` | 可选 | `AudioOutput`（实时发声）→ 预览用 |
| `headless` | 缺省 false | true 时不建 DOM 画布（Node 环境） |
| `seed` / `input` / `assets` | 可选 | 确定性注入面；变了就是另一次推演 |
| `onProgress` | 可选 | `(done, total) => void`，可据此早停 |

`RenderResult = { frames, durationMs, output }`；`output` 形态由 `Exporter` 决定。

帧载体（`packages/contracts/src/capture/ports.ts`）：

| 类型 | 形态 | 所有权 |
| --- | --- | --- |
| `FrameBitmap` | `{ data: Uint8ClampedArray, width, height }` | CPU 位图，可复用 |
| `FrameHandle` | `{ native, width, height, close() }` | 所有权随 `writeFrame` 转移，只能 `close()` 一次，不得跨帧持有 |
| `FrameSink` | `writeFrame(frame, index, timestampMs)` + `finalize()` | 帧交出点 |
| `FrameSource` | `(frame, t) => Carrier \| Promise<Carrier>` | 纯函数像素来源 |
| `FrameHost` | `begin(info)` + `frame()` + `close?()` | 带生命周期、可持跨帧状态；`begin` 每次推演调一次、禁并发重入 |

Exporter 五形态（`packages/contracts/src/export/ports.ts` + `packages/infra`；`ffmpeg` 是契约开放取值，本仓无适配器）：

| 形态 | 类 | 用途 |
| --- | --- | --- |
| `frames` | `FrameSequenceExporter` | 逐帧原始位图，无损，供再加工 |
| `webcodecs` | `WebCodecsExporter` | 浏览器硬编码 H.264 + AAC，自封装 mp4 |
| `webm` | `WebmExporter` | VP8/VP9 + Opus，自封装 webm；`{ alpha: true }` 加一条 alpha 侧通道 |
| `apng` | `ApngExporter` | 单文件动图，逐帧保 alpha——无音轨的透明产物走它 |
| — | `MemoryFrameSink` | 帧留内存，配 `frameFingerprint` 做测试 |
| — | `PacedPreviewExporter` + `CanvasBlitExporter` | 按音频时钟排帧 + 贴到页面画布 |
| — | `createReadbackHost(inner)` | 把交句柄的帧来源包成交位图（回读在帧来源侧，不在导出器里） |

## 硬约束

1. **`exporter` 必填**。没有渲染后端就没有产物；缺它会抛 `spec_violation`。
2. **必须有帧像素来源**：注入 `painter`，或给一个能 `getContext("2d")` 的 `canvas`。两者都没有时**首帧即报错**，除非显式 `frames: "allow-blank"`。
3. **`frames: "allow-blank"` 只豁免「没有帧来源」的报错，不豁免回读**。未注入 `painter` 时引擎每帧整幅 `getImageData`，720p 预览会从 30fps 掉到十几帧。预览必须注入 painter。
4. **顺序固定**：逐帧交帧 → `writeAudio` → `finalize`。音频块必须出现在封装元数据之前。
5. **帧载体所有权随 `writeFrame` 转移**。`FrameHandle` 只能 `close()` 一次；实现不得跨帧持有句柄。
6. **`Exporter.writeAudio` 缺省 = 纯视频**。场景有声音但导出器不支持 `writeAudio` 而你又传了 `audio`（`AudioClock`）→ 报错，不静默丢声。
7. **预览与导出传同一份注入**（`fps`、尺寸、`seed`、`input`、`assets`），否则两条路径分叉。
8. **透明产物要三处对齐**：`alpha: "alpha"` 声明、交**位图**的帧来源（句柄要包 `createReadbackHost`）、能装下 alpha 的封装（`webm` + `new WebmExporter({ alpha: true })`、`apng`、`frames`）。声明透明却配 mp4 → **首帧前** `spec_violation`，一帧都不写。声明只是声明，不是「自动清成透明」：每帧照样清屏，清成全透明。

## 骨架

```ts
import { render } from "@lingfan-video/core";
import { CanvasBlitExporter, PacedPreviewExporter, WebCodecsExporter } from "@lingfan-video/infra";

// 预览：按真实时钟排帧 + 贴到页面画布
const preview = new CanvasBlitExporter(
  new PacedPreviewExporter({ clock: () => performance.now() }),
  displayCanvas.getContext("2d")!,
);
await render(scene, {
  fps: 60, width: 960, height: 540,
  canvas: baseCanvas,
  exporter: preview,
  painter: host,                 // FrameHost 或 (frame, t) => FrameCarrier
  frames: "allow-blank",         // 只在这里是「预览 sink 自绘」的正当理由
  audioOutput,                   // 实时发声用 AudioOutput，不是 AudioClock
  headless: false,
  onProgress: (done, total) => setBar(done / total),
});

// 出片：硬编码 mp4，离线混音
const out = await render(scene, {
  fps: 30, width: 1280, height: 720,
  canvas: offscreen,
  exporter: new WebCodecsExporter({ /* 码率等 */ }),
  audio: new OfflineAudioMixer(),   // AudioClock：把程序混成样本块
  frames: "required",
});
// out.output 是 Blob/路径；out.frames / out.durationMs 是本次统计

// 透明产物：声明画布 + 交位图 + 保 alpha 的封装
const apng = await render(scene, {
  fps: 25, width: 320, height: 180,
  alpha: "alpha",                                  // 这一趟要透明画布
  painter: createReadbackHost(compositedHost),     // 句柄 → 位图；回读在帧来源侧
  exporter: new ApngExporter({ width: 320, height: 180 }),
});
```

- 帧序列模式（要再加工）：`FrameSequenceExporter`，产物是逐帧原始位图，无损。
- 透明产物（叠在别人画面上）：`alpha: "alpha"` + `ApngExporter`，留白处真透明而不是黑底；要带音轨的透明成片就换 `new WebmExporter({ alpha: true })`。
- Node 下测试：`MemoryFrameSink` 把帧留在内存里，配合 `frameFingerprint` 断言。
- `painter` 可以是同步函数，也可以返回 Promise（DOM/框架栅格化、GPU 回读）。

## 验证判据

```bash
pnpm vitest run tests/webcodecs-exporter.test.ts tests/export-audio.test.ts tests/backend-port.test.ts tests/preview-paced.test.ts tests/alpha-frames.test.ts tests/apng-exporter.test.ts tests/readback-host.test.ts tests/webm-muxer.test.ts tests/webm-exporter.test.ts
```

- 音轨确实写进去了：`tests/export-audio.test.ts`。
- 缺帧来源必报错、`allow-blank` 才放行：`tests/backend-port.test.ts`。
- 产物帧数/时长：`render` 返回 `{ frames, durationMs }`，与 `compute.computeRange` 的点数对比。
- 透明度真的从声明走到上下文：`tests/alpha-frames.test.ts`（声明随 `FrameHostInfo` 交宿主、宿主的 `begin` 收到、Canvas2D 按档建上下文、mp4 首帧前被拦）。
- 产物逐字节保 alpha、时长按时间戳差：`tests/apng-exporter.test.ts`。
- 句柄转位图与「非 2D 设备明确报错」：`tests/readback-host.test.ts`。
- webm 容器自己写对了：`tests/webm-muxer.test.ts`（EBML 骨架、SimpleBlock 与 BlockGroup 两种块、簇与 `CUES` 偏移真落在簇起点、Opus 轨道）。
- 透明 webm 的两路编码配对与 `BlockAdditions`：`tests/webm-exporter.test.ts`。

## 常见错法

| ✗ 错法 | 为什么错 | ✓ 改成 |
| --- | --- | --- |
| 以为 `frames: "allow-blank"` 能省掉回读 | 它只豁免「没有帧来源」的报错 | 预览注入 `painter`；不产像素才用 `allow-blank` |
| 在 `finalize` 之后补写帧 | 契约要求帧与音频块都在 finalize 之前 | 全部写入先做完，再 finalize |
| 拿到 `FrameHandle` 存起来下帧再用 | 所有权随 `writeFrame` 转移，引擎立即释放 | 当帧用完即弃；需要复用就自己拷成位图 |
| 有声音但导出器没有 `writeAudio` | 会抛 `spec_violation`，不静默丢声 | 换支持音轨的导出器，或去掉 `audio` |
| 预览和导出用不同 `fps` / 尺寸 | 注入不同 = 另一次推演，两条路径分叉 | 抽一份 `RenderOptions` 公共部分复用 |
| 认为 mp4 容器字节可复现 | 封装器版本与时间戳会影响字节；确定性判据是帧指纹序列 | 比 `sequenceFingerprint`，不比文件哈希 |
| 在适配器里偷偷回读 GPU 像素 | 违反「不许静默回读像素降级」 | 明确抛错，或走 `FrameBitmap` 路径 |
| 声明 `alpha: "alpha"` 却配 mp4 导出器 | H.264 结构上没有 alpha 通道，透明处被填黑；这份产物「看起来成功」比报错更坏 | 换 `new WebmExporter({ alpha: true })`（带音轨的透明成片）、`ApngExporter`（单文件动图）或 `FrameSequenceExporter`（原始 RGBA） |
| 用 `new WebmExporter({})` 却声明 `alpha: "alpha"` | WebM 的 alpha 不是格式自带，而是并行侧通道：实例没声明 `alpha: true` 就不会编 alpha 流 | 实例上写 `alpha: true`，同时 `RenderOptions.alpha` 也声明 `"alpha"`——两处都要 |
| 透明 webm 时让帧来源交 `FrameHandle` | alpha 侧通道要逐像素 alpha，句柄不承诺 CPU 可读；导出器不回读像素 | `painter: createReadbackHost(host)` 或把 alpha 声明改成 `"opaque"` |
| 用 ffprobe 看到 yuv420p 就以为 alpha 丢了 | VP9 的 alpha 是 `BlockAdditions` 侧通道，容器层像素格式仍是普通 yuv | 用支持 alpha 侧通道的解码器验证，或直接看同一个源出的 APNG |
| 以为 `alpha: "alpha"` 会替合成器自动清成透明 | 声明只说明这一趟要哪种画布，每帧照样要清；漏清会让上一帧留成鬼影 | 合成器按声明建场并按不变量清屏 |
| 在导出器里写「拿不到位图就 `getImageData` 兜底」 | 回读把编码降级成事后补救，还掩盖「这台设备没有 2D 上下文」的装配错误 | `createReadbackHost(inner)` 包在帧来源这一侧 |

## 边界与陷阱

- **确定性是分级的**：CPU 2D 路径承诺跨设备逐字节相同；GPU / 第三方框架只承诺同设备、同代码、同数据相同。
- **`export-audio` 的块序列**自 0 起连续、无空隙；布局取 `AudioClock` 的 `sampleRate` / `channels`，不要猜。
- **`FrameHost` 的 `begin` 每次推演调一次**，不得并发重入，状态不得跨 `begin` 沿用；`close` 必定尝试。
- **`audio` 与 `audioOutput` 是两条路**：`audio`（`AudioClock`）离线混音给导出器；`audioOutput`（`AudioOutput`）实时发声。预览可以只给 `audioOutput`。
- **`headless: true`** 时不创建 DOM 画布；Node 环境用 `headless` + 注入 `painter` 或 `allow-blank`。
- **alpha 在建场时定死**：它走 `Compositor.begin` 而不是 `composite`（上下文/设备的 alpha 能力是创建参数）；换档必须重新 `begin`。
- **`FrameHostInfo.alpha` 省略即 `"opaque"`**，且省略时宿主收到的信息里没有这个键——「没声明」与「显式声明不透明」可区分。
- **APNG 没有音轨，且只收 CPU 位图**：有声音会给 `writeAudio` 报错而不是静默丢音轨；收到 `FrameHandle` 即明确报错。
- **APNG 的内存随帧数线性增长**：`acTL` 要先声明总帧数，逐帧压好的扫描线必须留到 `finalize`；长片分段出或改用 `FrameSequenceExporter`。
- **webm 的 alpha 是侧通道，不是像素格式**：透明档多开一路只含关键帧的 alpha 编码器，逐帧字节落在块的 `BlockAdditions`（`BlockAddID=1`）里，容器轨道另写 `AlphaMode=1`。所以探针看到的仍是普通 yuv，`ALPHA_MODE` 与侧通道必须在同一份产物里对齐。
- **两条编码路径各自封容器**：`WebCodecsExporter`（H.264 + AAC → mp4，`mp4/` 自写 box）与 `WebmExporter`（VP8/VP9 + Opus → webm，EBML 自写段/簇/索引）互不复用封装代码，共用的是 `EncoderGate`（背压）与 `encode-limits`（队列上限、音频块大小）。
- **webm 的音频固定 48kHz Opus**：采样率不是 48000 时明确报错而不是静默重采样——重采样会让「同一份剧本逐样本相同」这条承诺失效。
- **透明档只收 CPU 位图**：alpha 侧通道要逐像素 alpha，收到 `FrameHandle` 即明确报错；`createReadbackHost` 包在帧来源那一侧。
- **预览不感知 alpha**：`CanvasBlitExporter` / `PacedPreviewExporter` 只负责贴到目标画布与按主时钟放行，`impl` / `format` 照抄内层，`alpha` 同样照抄。
