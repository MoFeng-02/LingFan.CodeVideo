# 导出（Exporter）

把一次推演的结果落成产物的端口：逐帧收画面、按块收声音、最后一次收尾交出 `ExportResult`。端口在 `packages/contracts/src/export/ports.ts`，实现由 `packages/infra/src/` 承载（`impl` 取 `"frames"` 或 `"webcodecs"`），缺省由组合根 `packages/core/src/index.ts` 装配。

## 何时用 / 何时不用

- 用：要把推演结果落成文件或目录，因为 `render` 的 `exporter` 是导出端唯一的注入面。
- 用：要出带音轨的成片，因为 `writeAudio` 存在时音频按程序渲染成样本块交进来。
- 用：只要逐帧原始位图做再加工，因为 `impl: "frames"` 的形态无损交位图。
- 用：要在浏览器里硬编成 mp4，因为 `impl: "webcodecs"` 的形态直接接编码器。
- 不用：只想在浏览器里按实时节奏播放，改用 `PacedPreviewExporter`，见 `docs/guides/debug-with-compute.md`。
- 不用：只关心帧不要产物文件，改用 `MemoryFrameSink`，见 `docs/contracts/capture.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 帧全部写完才写音频块，音频写完才 `finalize` | 调用记录恰为 `["frames","audio","finalize"]`，30 帧 @30fps 对应 1000 毫秒、1 个 48000 帧的音块 | `tests/export-audio.test.ts` |
| 场景没有声音时不调 `writeAudio` | 调用记录为 `["frames","finalize"]` | `tests/export-audio.test.ts` |
| 有声音但导出器没实现 `writeAudio` → `spec_violation` | 渲染以 `spec_violation` 结束 | `tests/export-audio.test.ts` |
| 有声音但没注入 `AudioClock` → `spec_violation` | 渲染以 `spec_violation` 结束 | `tests/export-audio.test.ts` |
| 位图按数据视图交给编码器，`subarray` 的 `byteOffset` / `byteLength` 不被抹平 | 编码器收到的视图偏移与长度等于原切片 | `tests/webcodecs-exporter.test.ts` |
| 位图尺寸或数据长度与导出尺寸不符 → 写帧前 `spec_violation` | 渲染在写帧前失败 | `tests/webcodecs-exporter.test.ts` |
| 编码器 `error` 回调之后，后续写入按同一错误失败，不静默继续 | 后续写入被拒绝 | `tests/webcodecs-exporter.test.ts` |
| 等待出队时编码器报错，挂起的写入被唤醒并失败 | 挂起写入以该错误结束 | `tests/webcodecs-exporter.test.ts` |
| 样本数不是声道数整数倍的坏块不占布局，之后合法块照常写入 | 布局仍由首个合法块决定 | `tests/webcodecs-exporter.test.ts` |
| 无帧时 `finalize` 失败不影响后续写入；失败后同一实例仍可再次收尾 | 重收尾成功 | `tests/webcodecs-exporter.test.ts` |
| 既无像素来源又未声明 `frames: "allow-blank"` → `spec_violation`，导出器收 0 帧 | 渲染抛错、帧数为 0 | `tests/frame-source.test.ts` |
| 显式 `frames: "allow-blank"` 才交出全 0 占位位图 | 位图每字节为 0 且导出正常收尾 | `tests/frame-source.test.ts` |

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
  painter: () => ({ data: new Uint8ClampedArray(W * H * 4), width: W, height: H }),
  audio: new OfflineAudioMixer(decoder, { sampleRate: 48_000, channels: 2 }), // 缺省不注入 = 纯视频
  exporter: new FrameSequenceExporter(),
});

void result.output; // ExportResult：产物路径或 Blob
void result.frames; // 本次实际写出的帧数
void result.durationMs; // 成片时长（毫秒）
```

自定义导出器：三件事——写帧、写声、收尾。

```ts
import type { Exporter, ExportResult, FrameCarrier, Ms } from "@lingfan-video/contracts";

class CountingExporter implements Exporter {
  readonly impl = "frames";
  readonly format = "frames";
  frames = 0;
  audioBlocks = 0;

  async writeFrame(_frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    void timestampMs; // 采样网格点的真实时间（毫秒）
    this.frames += 1;
  }

  async writeAudio(samples: Float32Array, sampleRate: number, channels: number): Promise<void> {
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
- 实现标识：`impl` 与本仓适配器对应的是 `"frames"`（逐帧位图）与 `"webcodecs"`（浏览器硬编）；`"ffmpeg"` 是契约里的开放取值，本仓没有对应适配器。
- 确定性前提：位图路径逐字节可比；编码产物受编码器与容器影响，比对用帧指纹而不是比较文件字节。

## 相关

- 端口源码：`packages/contracts/src/export/ports.ts`
- 入口选项：`packages/contracts/src/entry/ports.ts`（`exporter`、`audio`、`frames`）
- 相邻页：`docs/contracts/capture.md`、`docs/contracts/audio.md`、`docs/contracts/index.md`
