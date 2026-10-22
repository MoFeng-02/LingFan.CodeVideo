# 导出（Exporter）

把一次推演的结果落成产物的端口：逐帧收画面、按块收声音、最后一次收尾交出 `ExportResult`。端口在 `packages/contracts/src/export/ports.ts`，实现由 `packages/infra/src/` 承载（`impl` 取 `"frames"`、`"webcodecs"`、`"webm"` 或 `"apng"`），缺省由组合根 `packages/core/src/index.ts` 装配。

## 何时用 / 何时不用

- 用：要把推演结果落成文件或目录，因为 `render` 的 `exporter` 是导出端唯一的注入面。
- 用：要出带音轨的成片，因为 `writeAudio` 存在时音频按程序渲染成样本块交进来。
- 用：只要逐帧原始位图做再加工，因为 `impl: "frames"` 的形态无损交位图。
- 用：要在浏览器里硬编成 mp4，因为 `impl: "webcodecs"` 的形态直接接编码器。
- 用：要**带音轨的透明成片**，因为 `impl: "webm"` 的形态用 VP8/VP9 侧通道装 alpha，同时还能带 Opus 音轨。
- 用：要**透明产物**，因为 `impl: "apng"` 的形态逐帧保留 alpha，产物能叠在别人的画面上当素材。
- 不用：只想在浏览器里按实时节奏播放，改用 `PacedPreviewExporter`，见 `docs/guides/debug-with-compute.md`。
- 不用：只关心帧不要产物文件，改用 `MemoryFrameSink`，见 `docs/contracts/capture.md`。

## 断言表

| 断言                                                                           | 判据                                                                                           | 钉子                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 帧全部写完才写音频块，音频写完才 `finalize`                                    | 调用记录恰为 `["frames","audio","finalize"]`，30 帧 @30fps 对应 1000 毫秒、1 个 48000 帧的音块 | `tests/export-audio.test.ts`                                   |
| 场景没有声音时不调 `writeAudio`                                                | 调用记录为 `["frames","finalize"]`                                                             | `tests/export-audio.test.ts`                                   |
| 有声音但导出器没实现 `writeAudio` → `spec_violation`                           | 渲染以 `spec_violation` 结束                                                                   | `tests/export-audio.test.ts`                                   |
| 有声音但没注入 `AudioClock` → `spec_violation`                                 | 渲染以 `spec_violation` 结束                                                                   | `tests/export-audio.test.ts`                                   |
| 位图按数据视图交给编码器，`subarray` 的 `byteOffset` / `byteLength` 不被抹平   | 编码器收到的视图偏移与长度等于原切片                                                           | `tests/webcodecs-exporter.test.ts`                             |
| 位图尺寸或数据长度与导出尺寸不符 → 写帧前 `spec_violation`                     | 渲染在写帧前失败                                                                               | `tests/webcodecs-exporter.test.ts`                             |
| 编码器 `error` 回调之后，后续写入按同一错误失败，不静默继续                    | 后续写入被拒绝                                                                                 | `tests/webcodecs-exporter.test.ts`                             |
| 等待出队时编码器报错，挂起的写入被唤醒并失败                                   | 挂起写入以该错误结束                                                                           | `tests/webcodecs-exporter.test.ts`                             |
| 样本数不是声道数整数倍的坏块不占布局，之后合法块照常写入                       | 布局仍由首个合法块决定                                                                         | `tests/webcodecs-exporter.test.ts`                             |
| 无帧时 `finalize` 失败不影响后续写入；失败后同一实例仍可再次收尾               | 重收尾成功                                                                                     | `tests/webcodecs-exporter.test.ts`                             |
| 既无像素来源又未声明 `frames: "allow-blank"` → `spec_violation`，导出器收 0 帧 | 渲染抛错、帧数为 0                                                                             | `tests/frame-source.test.ts`                                   |
| 显式 `frames: "allow-blank"` 才交出全 0 占位位图                               | 位图每字节为 0 且导出正常收尾                                                                  | `tests/frame-source.test.ts`                                   |
| 声明 `alpha: "alpha"` 却用 `format: "mp4"` 的导出器 → 首帧前 `spec_violation`  | 报错文案指明 H.264 无 alpha 通道，且导出器收 0 帧                                              | `tests/alpha-frames.test.ts`「声明 \"alpha\" 却用 mp4 封装」   |
| 不声明透明时 mp4 照常放行                                                      | 渲染正常完成，帧数等于推演帧数                                                                 | `tests/alpha-frames.test.ts`「不声明透明时 mp4 照常放行」      |
| APNG 分块顺序为 签名/IHDR/acTL/fcTL+IDAT/…/IEND，每块 CRC 合法                 | 逐块解析出的类型序列与 CRC 校验均通过                                                          | `tests/apng-exporter.test.ts`「分块顺序是…每块 CRC 合法」      |
| APNG 逐字节保留 alpha 通道                                                     | 解压 IDAT 后每行过滤字节为 0、像素 alpha 与输入一致                                            | `tests/apng-exporter.test.ts`「alpha 通道逐字节落进产物」      |
| APNG 停留时长取相邻时间戳差，变帧率不被抹平                                    | fcTL 的 delay 分子/分母序列等于各段间隔（分母 1000）                                           | `tests/apng-exporter.test.ts`「停留时长按相邻时间戳差表达」    |
| APNG 只收 CPU 位图：句柄与尺寸不符的帧都明确报错                               | 抛错文案分别指明「需要 CPU 像素」与「帧尺寸不一致」                                            | `tests/apng-exporter.test.ts`「只收 CPU 位图」                 |
| 同一组输入两次封装得到完全相同的字节                                           | 两次 `fileBytes` 逐字节相等                                                                    | `tests/apng-exporter.test.ts`「同一组输入两次封装」            |
| WebM 顶层是 EBML 头 + 段，DocType 声明 webm                                    | 解析出的顶层元素序列与 DocType 字符串匹配                                                      | `tests/webm-muxer.test.ts`「顶层是 EBML 头 + 段」              |
| 透明档在轨道上声明 AlphaMode，不透明档不写这个元素                             | 轨道元素里是否出现 AlphaMode 等于实例的 alpha 声明                                             | `tests/webm-muxer.test.ts`「透明档在轨道上声明 AlphaMode」     |
| 不透明块走 SimpleBlock，关键帧标志位写在块头                                   | 块元素类型与首字节标志位匹配                                                                   | `tests/webm-muxer.test.ts`「不透明块走 SimpleBlock」           |
| 透明块走 BlockGroup：块本体 + BlockAdditions 里的 alpha 平面                   | 块元素结构与附加数据 id 匹配                                                                   | `tests/webm-muxer.test.ts`「透明块走 BlockGroup」              |
| 音频块与视频块按时间合并进同一簇                                               | 同一簇内出现两条轨道的块                                                                       | `tests/webm-muxer.test.ts`「音频块与视频块按时间合并进同一簇」 |
| 没有视频块时收尾明确报错，而不是出一个空文件                                   | `finalize` 抛错                                                                                | `tests/webm-muxer.test.ts`「没有视频块时收尾明确报错」         |
| WebM 位图按数据视图交给编码器，`subarray` 偏移不被抹平                         | 编码器收到的视图偏移与长度等于原切片                                                           | `tests/webm-exporter.test.ts`「位图按数据视图交出」            |
| 透明档多开一个编码器，把 alpha 铺进 RGB 三通道                                 | 第二路编码器的输入每像素三通道等于原 alpha                                                     | `tests/webm-exporter.test.ts`「多开一个编码器」                |
| 透明档只收位图：设备句柄明确报错，而不是回读像素                               | 写入以 `spec_violation` 失败                                                                   | `tests/webm-exporter.test.ts`「透明档只收位图」                |
| 两路编码块配齐才交给容器，收尾时没有残留                                       | 收尾后容器里的块数等于帧数                                                                     | `tests/webm-exporter.test.ts`「两路编码块配齐才交给容器」      |
| WebM 音频按 48kHz 与声道数配置 Opus，采样率不符即报错                          | 编码器配置与报错文案匹配                                                                       | `tests/webm-exporter.test.ts`「Opus 编码器按 48kHz」           |

## 用法

出片：注入一个导出器，其余按缺省装配。

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter, OfflineAudioMixer } from "@lingfan-video/infra";

const W = 320;
const H = 180;
const FPS = 30;

const scene = start(1000, (env) => {
  env.step(1000, () => {
    /* 逐帧画面状态 */
  });
  env.synth({ wave: "sine", freq: 440, durationMs: 600 }); // 合成音源进音轨
});

// 合成音源不经过解码器；用素材声音时换成真实的 AudioDecoder 实现
const decoder = {
  async decode() {
    throw new Error("本段只用合成音源，不解码素材");
  },
};

const result = await render(scene, {
  fps: FPS,
  width: W,
  height: H,
  // painter 缺省 = 从绘制目标 canvas 的 2D 上下文回读；Node 里没有 canvas，必须给帧来源
  painter: () => ({
    data: new Uint8ClampedArray(W * H * 4),
    width: W,
    height: H,
  }),
  audio: new OfflineAudioMixer(decoder, { sampleRate: 48_000, channels: 2 }), // 缺省不注入 = 纯视频
  exporter: new FrameSequenceExporter(),
});

void result.output; // ExportResult：产物路径或 Blob
void result.frames; // 本次实际写出的帧数
void result.durationMs; // 成片时长（毫秒）
```

自定义导出器：三件事——写帧、写声、收尾。

```ts
import type {
  Exporter,
  ExportResult,
  FrameCarrier,
  Ms,
} from "@lingfan-video/contracts";

class CountingExporter implements Exporter {
  readonly impl = "frames";
  readonly format = "frames";
  frames = 0;
  audioBlocks = 0;

  async writeFrame(_frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    void timestampMs; // 采样网格点的真实时间（毫秒）
    this.frames += 1;
  }

  async writeAudio(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void> {
    void sampleRate;
    void channels;
    void samples; // 交错 Float32，长度 = 帧数 × channels
    this.audioBlocks += 1;
  }

  async finalize(): Promise<ExportResult> {
    return {
      output: "/tmp/out", // 帧序列模式是目录路径；编码模式是封装文件路径或 Blob
      frames: this.frames,
      durationMs: 1000,
      format: this.format,
    };
  }
}

const exporter = new CountingExporter();
void exporter;
```

透明产物：声明 `alpha`，配上能装下 alpha 的封装。

```ts
import { render, start } from "@lingfan-video/core";
import { ApngExporter } from "@lingfan-video/infra";

const scene = start(500, (env) => {
  env.step(500, () => {
    /* 只画主体，四周留空——留空处靠 alpha 透出去 */
  });
});

const result = await render(scene, {
  fps: 25,
  width: 320,
  height: 180,
  alpha: "alpha", // 声明：这一趟要的是透明画布
  painter: () => ({
    data: new Uint8ClampedArray(320 * 180 * 4),
    width: 320,
    height: 180,
  }),
  exporter: new ApngExporter({ width: 320, height: 180 }),
});

void result.output; // Blob，image/apng：逐帧保留 alpha，可直接叠在别人的画面上
```

要带音轨的透明成片：`alpha` 声明两处都要给——入口声明这一趟要透明画布，导出器实例声明这个产物装得下 alpha。

```ts
import { render, start } from "@lingfan-video/core";
import { WebmExporter } from "@lingfan-video/infra";

const result = await render(scene, {
  fps: 30,
  width: 1280,
  height: 720,
  alpha: "alpha",
  painter: () => ({
    data: new Uint8ClampedArray(1280 * 720 * 4),
    width: 1280,
    height: 720,
  }),
  exporter: new WebmExporter({
    width: 1280,
    height: 720,
    fps: 30,
    alpha: true,
  }),
});

void result.output; // Blob，video/webm：VP9 颜色轨 + 一条 alpha 侧通道，另有 Opus 音轨
```

## 反例

- ✗ 写法：在 `writeFrame` 里 `await` 一个耗时上传，把 `frame` 存起来延后处理 —— 为什么错：句柄的生命周期归引擎，`writeFrame` 返回后引擎立即释放它，实现不得跨帧持有；✓ 改成：在 `writeFrame` 内消费完，需要保留就自己 `clone()`。
- ✗ 写法：导出器同时给 `writeAudio` 和「拿不到句柄就回读像素」的降级分支 —— 为什么错：契约要求两种载体要么都接、要么明确抛错，静默回读会改变像素路径且掩盖配置错误；✓ 改成：不支持句柄就明确抛错并提示换实现。
- ✗ 写法：把 `finalize()` 当成「随时可以再写」的存档点，之后继续 `writeFrame` —— 为什么错：封装需要完整元数据，帧与音频块都必须在 `finalize` 之前写完，调用后不得再写入；✓ 改成：先写完所有帧与音频块，再调一次 `finalize`。
- ✗ 写法：把整轨 PCM 一次性切成不等长块、块间留空隙 —— 为什么错：块序列契约是自 0 起连续、无空隙，接收端按顺序拼接即整轨；✓ 改成：相邻块首尾相接，长度各自 = 该块帧数 × `channels`。
- ✗ 写法：用 `frames: "allow-blank"` 绕开「没有像素来源」的报错，却指望拿到真实画面 —— 为什么错：它只豁免「没有帧来源」这条报错，交给导出器的是全 0 占位位图，回读与编码流程照旧执行；✓ 改成：要真实画面就注入 `painter` 或可 2D 的 `canvas`。

## 边界与陷阱

- `Exporter.writeAudio`：可选项。缺省不实现 = 纯视频导出。实现它时 `samples` 是交错 Float32 PCM，长度必须等于帧数 × `channels`（样本数不是 `channels` 整数倍的块在写帧前就报 `spec_violation`，且不占掉音轨布局）。
- 音轨布局：`sampleRate` 与 `channels` 取自 `AudioClock` 的声明，首个合法块定布局；后续块与首块不一致 → `spec_violation`（同一条音轨布局必须一致）。
- 音频块的顺序：自 0 起、按时间顺序连续、无空隙；拼接即整轨。
- `frames: "required"`（缺省）：既无 `painter`、绘制目标也没有 2D 上下文 → 首帧求值 `spec_violation`，不静默交空白帧。
- `frames: "allow-blank"`：显式接受全 0 占位位图，用于预览 sink 自绘、或只关心时间与音频的场合。它只豁免「没有帧来源」这条报错，不豁免回读、不豁免编码、不豁免 `finalize`。
- `writeFrame` 的 `timestampMs`：采样网格点时间（毫秒）。变帧率下不要用帧号乘帧长反推。
- `finalize` 的返回：`output` 在帧序列模式是目录或文件路径，在编码模式是封装文件路径或 Blob；`frames` 是本次实际写出的帧数，`durationMs` 是成片时长（毫秒）。
- 调序由引擎保证：先写完所有帧、再写完音频块、最后 `finalize`。音频块必须出现在封装元数据之前。
- 有声音而缺 `AudioClock` 时报错而不是静默丢音轨；有 `AudioClock` 而导出器不实现 `writeAudio` 同样报错。
- 编码器进入错误态后不会恢复：后续写入沿用同一错误；`finalize` 失败可重试，重试成功后同一实例仍可继续写入。
- 实现标识：`impl` 与本仓适配器对应的是 `"frames"`（逐帧位图）、`"webcodecs"`（浏览器硬编 H.264/AAC 出 mp4）、`"webm"`（VP8/VP9 + Opus 出 webm，可选 alpha 侧通道）与 `"apng"`（逐帧保 alpha 的单文件动图）；`"ffmpeg"` 是契约里的开放取值，本仓没有对应适配器。
- `Exporter.alpha`：可选项，声明**这个实例的产物是否携带 alpha**。省略即不携带。格式只是必要条件不是充分条件——同一种封装可以在建实例时选带不带 alpha（`new WebmExporter({ ..., alpha: true })` 才装 alpha 侧通道）。引擎拿它和 `RenderOptions.alpha` 对账，对不上在首帧前就报错。
- 透明产物：产物能不能带 alpha 由封装与实例声明共同决定，不由导出器努力程度决定。H.264/mp4 结构上没有 alpha 通道，透明区域进编码器只会被填黑；WebM 的 alpha 是并行侧通道（第二条只含关键帧的编码流，容器里落在 BlockAdditions），要在编码器与容器两侧都声明；APNG 与逐帧位图直接保留 RGBA 的 alpha。所以声明 `alpha: "alpha"` 却配了装不下 alpha 的导出器会在首帧前报 `spec_violation`。
- 透明 WebM 的两路编码：颜色轨与 alpha 轨按时间戳配对，配不齐在收尾时明确报错（不会静默丢一半）。alpha 轨编码成本单列一个码率上限（`alphaBitrate`），透明档导出要按两路算耗时。
- 逐像素封装的代价：APNG 每帧要压一遍扫描线。压好的块边写边攒（攒的是压缩后字节，不是原始 RGBA × 帧数），收尾时才把动画控制块插到帧块之前——总帧数因此不必提前声明。长片要透明仍可优先考虑 WebM 那一路（边编边写、内存不随帧数增长）。
- 有声音 + APNG：APNG 没有音轨，`writeAudio` 被调用即报错而不是静默丢音轨。要**带声音的透明成片**用 `WebmExporter`（Opus 音轨 + alpha 侧通道），这是本仓唯一同时装得下音轨与 alpha 的适配器。
- WebM 音频固定 48kHz：Opus 的采样率写死在码流头里，48kHz 之外的输入在首块即报 `spec_violation`，不做静默重采样。
- 确定性前提：位图路径逐字节可比；APNG 是纯内存封装、无编码器参与，因此同一组输入两次封装字节完全相同；mp4 与 webm 两路受编码器与容器影响，比对用帧指纹而不是比较文件字节。

## 相关

- 端口源码：`packages/contracts/src/export/ports.ts`
- 入口选项：`packages/contracts/src/entry/ports.ts`（`exporter`、`audio`、`frames`）
- 相邻页：`docs/contracts/capture.md`、`docs/contracts/audio.md`、`docs/contracts/index.md`
