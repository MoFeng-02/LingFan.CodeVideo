# 不整片出片就验证：静态检查、状态取样与帧指纹

三条旁路能力——`validateScene`（`validate()` 的入口包装）、`compute.computeAt/computeRange`（`ComputeFns` 端口）、诊断适配器（`packages/infra/src/diagnostics/`：`frameFingerprint` / `sequenceFingerprint` / `frameDelta` / `continuityReport` / `FrameHasher` / `auditDeterminism`）——都不需要整片出片，也不属于推演本身。

## 何时用 / 何时不用

- **用**：改完剧本先看结构对不对；想知道某一刻的状态而不想跑完整个时间线；要写「两次推演逐帧一致」的回归断言；要在 CI 里查切点有没有跳帧。
- **不用**：要看最终画面质量或听声音 → `export-mp4.md`；要检查音频程序 → `add-audio.md` 的 `compileAudioProgram`；要修帧合成 → 层声明与宿主相关页。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| `validate` 是纯检查：返回错误表，不抛异常；合法剧本得空数组 | `validateScene(scene)` → `[]` | `tests/validate-pool.test.ts`「合法剧本零错误」 |
| 单元窗口越出段窗口在静态检查阶段就报出来 | 3000ms 窗、30fps 下 `env.f(90)` → `window_overflow` | `tests/validate-pool.test.ts`「f(90) 越窗：at 越窗 → window_overflow」 |
| 链上重复链接（同一幕两个出口）在登记期就抛 `spec_violation` | `cutTo` 两次 → 抛错 | `tests/validate-pool.test.ts`「重复链接（cutTo 两个出口）→ throw spec_violation」 |
| 登记体干跑抛错会被捕获成校验错误，而不是让校验崩掉 | `body 干跑抛错 → spec_violation` | `tests/validate-pool.test.ts`「body 干跑抛错 → spec_violation」 |
| 同一像素得同一指纹；改一个像素或改尺寸即变 | `frameFingerprint(pre)` / `frameDelta(pre, overOnePixel)` 给出变化占比 | `tests/frame-diagnostics.test.ts`「同像素同指纹，改一个像素即变，尺寸参与指纹」 |
| 整段指纹：序列相同则相同，任一帧不同则不同 | `sequenceFingerprint(a)`、`sequenceFingerprint(c)` | `tests/frame-diagnostics.test.ts`「整段指纹：序列相同则相同，任一帧不同则不同」 |
| 完全相同的帧 → 三项差值全 0；单像素改动可算出占比与差值 | `frameDelta(pre, pre)` → `{meanAbsDiff:0, maxAbsDiff:0, changedRatio:0}` | `tests/frame-diagnostics.test.ts`「完全相同 → 全 0；单像素改动 → 变化占比与差值可算」 |
| 匀速运动无尖峰；硬切被识别为尖峰且平滑度变差 | `continuityReport` 的 `spikeIndices` 含切点 | `tests/frame-diagnostics.test.ts`「匀速移动没有尖峰；切镜被识别为尖峰且平滑度变差」 |
| 两遍推演必须完全一致：帧数、时间戳、指纹逐项相等 | `auditDeterminism(run)` → `identical === true` | `tests/frame-diagnostics.test.ts`「compareFrameHashes 与 auditDeterminism：同一次推演跑两遍必须完全一致」 |
| 指纹旁路不改帧：`FrameHasher` 先记指纹再原样转发下游 | 下游收到的帧与上游同一对象引用 | `tests/frame-diagnostics.test.ts`「FrameHasher 逐帧记指纹并原样转发下游」 |
| 同一刻求两次状态相等（可计算） | `compute.computeAt(scene, t)` 两次结果相同 | `tests/ledger-timeline.test.ts`「可计算：同一刻求两次状态相等」 |
| 探针推两遍：帧时间戳与指纹序列一致 | 两遍的 `timestamps` 与指纹数组逐项相等 | `tests/ledger-timeline.test.ts`「确定性：探针推两遍，帧时间戳与指纹序列一致」 |
| 池消耗可静态算清：Σstep + Σwait + Σpar-max | 100 + 200 + max(300,100) = 600ms | `tests/validate-pool.test.ts`「池消耗 = Σstep + Σwait + Σpar-max」 |

## 用法

### 1. 静态检查：`validateScene`

```ts
import { validateScene } from "@lingfan-video/core";

const errors = validateScene(scene); // ValidationError[]，空数组即通过
if (errors.length > 0) {
  for (const e of errors) console.error(`${e.path} [${e.code}] ${e.message}`);
}
```

- 纯函数：干跑一遍登记体，返回错误表，不抛异常（`body 干跑抛错` 与链成环也被收成错误项）。
- 干跑时画布为空：登记体必须只登记、不依赖真实画布。
- 错误码只有两类：`window_overflow`（越窗）与 `spec_violation`（结构/参数非法）。
- 固定按 60fps 干跑（`validate(scene, 60)`），与 `RenderOptions.fps` 无关。

### 2. 状态取样：`compute.computeAt` / `compute.computeRange`

```ts
import { compute } from "@lingfan-video/core";

const st = await compute.computeAt(scene, 600); // 取 ≤600ms 的最近采样点状态，可能为 undefined
const table = await compute.computeRange(scene, 0, 2000); // [0,2000) 内全部采样点，按时间升序
```

- `computeAt`：越过时间线尾、或早于首个采样网格点 → `undefined`。
- `computeRange`：左闭右开；采样点**就是该时间线的采样网格点**，不是等距切分。第三个参数 `stepMs` 只是兼容旧调用位，不改变取样密度。
- 每次调用独立建引擎、独立登记一遍；单次调用内登记只发生一次（不会逐点重登记）。
- 取样引擎固定 `fps: 60`、`width/height: 1`、`headless`，不产帧、不碰画布。

### 3. 帧指纹与两遍比对

```ts
import { FrameHasher, auditDeterminism, compareFingerprints, sequenceFingerprint } from "@lingfan-video/infra";

// 两遍推演，逐帧比对
const report = await auditDeterminism(produceFrames);
if (!report.identical) throw new Error(`第 ${report.mismatches[0]?.at} 帧不一致`);

// 流式：边推边记指纹，不缓存像素
const hasher = new FrameHasher(downstreamSink); // 下游可省略
await render(scene, { fps: 30, width: 1280, height: 720, exporter: /* 任意 Exporter */, painter });
const digest = sequenceFingerprint(hasher.fingerprints());
```

- 指纹是 **16 位小写十六进制**的弱摘要（非密码学）。只读 `width` / `height` / `data`，不读 `kind`，所以同尺寸的设备回读像素得同一指纹。
- `sequenceFingerprint` 把整段压成一个摘要：长度或顺序不同即不同；0 帧也给一个非空摘要。
- `compareFingerprints(baseline, candidate, { maxMismatches })`：`maxMismatches` 缺省 5，≤0 抛 `spec_violation`；两侧长度可不同，`frames` 取较大值，缺的帧占位 `<缺帧>`；只有长度相等且无差异才 `identical === true`。
- `FrameHasher` 只认 CPU 位图。设备句柄不能回读，它在收帧时直接抛错，而不是悄悄降级。

### 4. 帧差与连续性

```ts
import { frameDelta, continuityReport } from "@lingfan-video/infra";

const d = frameDelta(prev, next); // { meanAbsDiff: 0..255, maxAbsDiff: 0..255, changedRatio: 0..1 }
const c = continuityReport(frames, { spikeFactor: 3 }); // spikeFactor 缺省 3
console.log(c.maxDeltaAt, c.spikeIndices, c.smoothness);
```

- 差值含 alpha 通道；尺寸或缓冲长度不符直接抛 `spec_violation`，不猜。
- `continuityReport` 的尖峰阈值是 `max(meanDelta × spikeFactor, 1)`；`spikeFactor` 非正数抛 `spec_violation`；帧数 < 2 返回空序列、不报错。
- 用绝对时间遮盖做过场时，切点应当**没有**尖峰；换回硬切就会跳。连续性来自写法，不是数据本身平滑。

### 5. 早停：跑到某一刻就收手

不做整片推演也能拿到某一刻的像素：用一个「命中就抛」的 `Exporter` 包住真实调用，捕获后按记录的时间戳判断。

> 伪代码

```ts
class StillStop extends Error {}

class StillFrame implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  hit = false;
  frames = 0;
  lastMs = 0;
  constructor(private readonly at: Ms) {}
  async writeFrame(_frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    this.frames += 1;
    this.lastMs = timestampMs;
    if (timestampMs >= this.at) {
      this.hit = true;
      throw new StillStop();
    }
  }
  async finalize(): Promise<ExportResult> {
    return { output: "(still)", frames: this.frames, durationMs: this.lastMs, format: "frames" };
  }
}
```

外面用 `new CanvasBlitExporter(still, stage)` 包一层，先让内核判停再把这一帧贴上目标画布，于是抛错那一帧也已经可见。

### 6. 时间换算（纯函数，不用引擎）

```ts
import { timestampAt, msToFrames, framesToMs, frameCount } from "@lingfan-video/core";

timestampAt(30, 30); // 1000ms
msToFrames(2500, 60); // 150
framesToMs(150, 60); // 2500ms
frameCount(2500, 60); // 150（msToFrames 的别名）
```

`timestampAt(i, fps) = (i × 1000) / fps` 是恒等式乘法，不做逐帧累加，所以不会累积浮点误差。

## 反例

✗ **用容器字节判断确定性**

> 伪代码

```ts
const a = await render(scene, opts);
const b = await render(scene, opts);
expect(a.output.output).toEqual(b.output.output); // mp4 字节
```

为什么错：mp4 里含封装时间、编码器版本相关的写入细节，字节相同既不是确定性的必要条件是也不是充分条件。确定性的判据是**帧指纹序列**。

✓

> 伪代码

```ts
const report = await auditDeterminism(produceFrames);
expect(report.identical).toBe(true);
```

✗ **用等距采样代替推演的采样网格**

> 伪代码

```ts
for (let t = 0; t < 2000; t += 100) await compute.computeAt(scene, t);
```

为什么错：采样点是各活跃单元网格点的并集，不是等距切分——空窗不产帧，单元还可以有自己的 fps。自己按 100ms 走会问到推演里根本不存在的时刻，拿到的其实是「≤t 的最近网格点」状态，断言会假过。

✓ 用 `computeRange` 拿真实的网格点：

> 伪代码

```ts
const table = await compute.computeRange(scene, 0, 2000);
```

✗ **以为 `frames: "allow-blank"` 能让诊断跑得更快**

为什么错：它只豁免「没有帧来源」的报错，不豁免回读——未注入 `painter` 时引擎每帧仍从整幅画布 `getImageData`，720p 会从 30fps 掉到十几帧，诊断反而更慢。

✓ 注入返回位图的 `painter`，或让后端交位图给 `FrameHasher`。

## 边界与陷阱

- **指纹不是校验和**：16 位弱摘要，碰撞概率在诊断里可接受，不要拿它做安全校验。
- **`FrameHasher` 拒收设备句柄**：GPU 路径要在编码前旁路取样，或者让后端交位图；硬塞句柄会直接抛错。
- **`auditDeterminism` 把帧全留内存**：大分辨率长片会吃内存，流式场景直接用 `FrameHasher`。
- **`compareFingerprints` 的 `identical` 要求长度相等**：一侧多一帧就不算一致，即使前面全部相同。
- **`compute` 每次调用重建引擎**：连续取多个时刻请用 `computeRange`，别循环调 `computeAt`。
- **`computeAt` 可能返回 `undefined`**：时间线尾之后、首个网格点之前都取不到，调用方必须处理。
- **链式剧本一律从链头取样**：`cutTo` 返回链尾，`render` / `compute` / `validateScene` 都只接受链头。
- **诊断不参与出片**：这些函数不改帧、不改时间线，加进流水线也不影响产物；反过来说，它们也修不了画面问题。

## 相关

- 端口源码：`packages/contracts/src/entry/ports.ts`（`ValidateFn` / `ComputeFns` / `RenderOptions`）、`packages/contracts/src/capture/ports.ts`（`FrameSink` / `FrameBitmap`）、`packages/contracts/src/feedback/entities.ts`（`ValidationError` / `RenderError` / `FrameState`）；实现见 `packages/infra/src/diagnostics/`（`hash.ts` / `metrics.ts` / `audit.ts`）、`packages/core/src/domain/validation/validate.ts`、`packages/core/src/app/runtime/engine.ts`、`packages/core/src/domain/time-math/time-math.ts`。
- 示例：`examples/compute-query/main.ts`（`validateScene` → `computeAt` → `computeRange` → 链式从链头取样）、`examples/browser/playback.ts`（早停的 `StillFrame` 导出器）。
- 相邻页：`first-clip.md`（单幕入口）、`compose-acts.md`（多幕与重叠窗）、`add-audio.md`（声音）、`export-mp4.md`（出片与确定性分级）。
