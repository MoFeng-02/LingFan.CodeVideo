# @lingfan-video/infra

Code Video 契约的**默认适配器集**：端口在这里有可跑的实现，换一套实现不影响业务代码。

## 它是什么

只依赖 `@lingfan-video/contracts`——本包不知道 `core` 存在，也不该知道。
它把平台能力（画布、编码器、音频设备、WebAudio、three）包成契约端口，由上层组合根挑选装配。

## 怎么用

```ts
import { FrameSequenceExporter } from "@lingfan-video/infra";

await render(scene, { fps: 30, width: 640, height: 360, exporter: new FrameSequenceExporter() });
```

## 出口分组

| 分组 | 出口 |
| --- | --- |
| 导出 | `FrameSequenceExporter`（逐帧原始位图）、`WebCodecsExporter`（H.264 + AAC-LC，产物 mp4）、`Mp4Muxer` 与轨道/块类型 |
| 预览 | `PacedPreviewExporter`（按音频时钟排帧）、`CanvasBlitExporter`（贴到页面画布） |
| 帧合成 | 经 `./frames` 再导出：`createCompositeHost`、`createCanvas2dCompositor`、`planComposite`、`isLayerActive`、载体工具 |
| 采集 | `MemoryFrameSink`（帧留在内存里供断言/比对） |
| 诊断 | `frameFingerprint` / `sequenceFingerprint` / `frameDelta` / `continuityReport` / `FrameHasher` / `auditDeterminism` |
| 音频 | `OfflineAudioMixer`、`WebAudioOutput`、合成器工具（`renderSynth` / `seededRandom` 等）、`voice-timeline`、`warp` |

## 子路径导出

`three` 适配器按需加载，不经包根，避免把所有依赖拖进默认路径：

```ts
import { ... } from "@lingfan-video/infra/frames/adapters/three";
import { ... } from "@lingfan-video/infra/frames/adapters/three-compositor";
```

## 三条纪律

1. **实现只认契约**：本包不 import `core`；实现里出现第二个包的名字就是越界。
2. **默认不是唯一**：每个端口都可以被替换。`createCanvas2dCompositor` 只是缺省合成器。
3. **确定性分级**：CPU 2D 路径跨设备逐字节可复现；GPU 路径只承诺同设备可复现，写测试时按分级断言。

## 读什么

- 出片与预览：[`docs/guides/export-mp4.md`](../../docs/guides/export-mp4.md)
- 音频混音与总线：[`docs/guides/add-audio.md`](../../docs/guides/add-audio.md)
- 不整片渲染的验证手段：[`docs/guides/debug-with-compute.md`](../../docs/guides/debug-with-compute.md)
- 端口语义：[`docs/contracts/`](../../docs/contracts/index.md)
