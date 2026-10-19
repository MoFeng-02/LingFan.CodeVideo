---
name: codevideo-verify
description: 不整片出片就验证：validate 的静态检查、compute.computeAt / computeRange 的状态取样、frameFingerprint / sequenceFingerprint 帧指纹、frameDelta / continuityReport 连贯性、FrameHasher 与 auditDeterminism 两遍比对。Use when checking whether a scene is correct, whether two runs are identical, or when writing a regression test without rendering the whole video.
metadata:
  version: "2.0.0"
---

# 验证与调试

验证分三层：**结构**（`validate` 干跑，不产一帧）、**取样**（`compute` 拿某刻的状态，不产位图）、**像素**（指纹与差分量，不整片出片）。判据是**可计算的数字**，「看起来对」不算验证。验证也不依赖整片推演：取样只开需要的时间窗，能单测的纯函数直接单测。

## 何时用 / 何时不用

- 用：改完剧本想确认没越窗、想知道某毫秒的状态是什么、要给改动钉一条回归测试、判断两次推演是否逐帧相同。
- 不用：要出 mp4 或接预览 → `codevideo-export`；要写剧本本身 → `codevideo-scene` / `codevideo-schedule`。

## API 面备查（签名以源码为准）

| 你要 | API | 要点 |
| --- | --- | --- |
| 结构干跑 | `validate(scene, fps = 60)` | 零帧产出；返回 `ValidationError[]`，空数组 = 通过 |
| 单刻取样 | `compute.computeAt(scene, t)` | 取 ≤t 的最近采样点状态；无活跃点/越界返回 `undefined`（不是抛错） |
| 区间取样 | `compute.computeRange(scene, from, to, stepMs?)` | 点集 = 采样网格 ∩ `[from, to)`；`stepMs` 只是保留参数位 |
| 单帧指纹 | `frameFingerprint(bitmap): string` | 16 位小写十六进制；只读 `width`/`height`/`data`，不读 `kind` |
| 序列指纹 | `sequenceFingerprint(fingerprints): string` | 对顺序与长度敏感；确定性判据 |
| 帧间差分 | `frameDelta(a, b): FrameDelta` | `{ meanAbsDiff, maxAbsDiff, changedRatio }` |
| 连贯性 | `continuityReport(frames, { spikeFactor = 3 })` | 阈值 = max(meanDelta × 3, 1)；匀速无尖峰、切镜有 |
| 旁路哈希 | `new FrameHasher(downstream?)` | 实现 `FrameSink`，逐帧记指纹并原样转发 |
| 两遍比对 | `auditDeterminism(produce, { maxMismatches = 5 })` | `produce` 被调两次，必须可重入；返回 `{ identical, mismatches }` |
| 错误形态 | `RenderError{ kind, sceneId, cursor, expected?, actual? }` | kind 闭集：`spec_violation` / `window_overflow` / `step_throw` / `spawn_crash` |

`compute` 每次调用独立建引擎（headless、60fps 网格、不产位图）；实现装配在 `packages/core/src/index.ts`，检查范围在 `packages/core/src/domain/validation/validate.ts`，诊断工具在 `packages/infra/src/diagnostics/`。

## 硬约束

1. **`compute` 不是「任意时刻取整片快照」**。`computeAt` 取 **≤ t 的最近采样点**；`t` 早于首个网格点或越过时间线尾时返回 `undefined`，不是抛错。
2. **`computeRange` 的点集是采样网格 ∩ `[from, to)`**，不是等距切分。`stepMs` 只是保留参数位，网格密度优先。
3. **每次 `compute` 调用独立建引擎、独立登记一遍**。不要把两次 `computeAt` 的返回值当作「同一引擎的连续状态」拼起来。
4. **指纹只读像素与尺寸**（`width`、`height`、`data`），不读 `kind`。所以同尺寸的 CPU 位图与设备回读位图会得到相同指纹。
5. **确定性判据是帧指纹序列，不是容器字节**。mp4 的字节受封装器版本与时间戳影响，哈希比对必然假阴性。
6. **`auditDeterminism` 的 `produce` 会被调用两次**。它必须是可重入的纯产帧函数，不能持有累积状态。
7. **确定性是分级的**：CPU 2D 路径承诺跨设备逐字节相同；GPU 与第三方框架只承诺同设备、同代码、同数据相同。
8. **验证按需开窗，不跑全片**。`computeRange` 只传关心的区间：关心 800–1200ms 的过场就 `(scene, 800, 1_200)`，不要从 0 扫到尾。时间换算、音频组合子、`validate` 这类纯函数不建引擎，测试直接 import 调用断言。

## 骨架

```ts
import { compute, validate, render, start } from "@lingfan-video/core";
import {
  FrameHasher, auditDeterminism, continuityReport,
  frameDelta, frameFingerprint, sequenceFingerprint,
} from "@lingfan-video/infra";

// 1) 结构：干跑，零帧产出。空数组 = 通过
const errors = validate(scene, 60);        // fps 只影响登记期缺省一帧的时长
if (errors.length > 0) console.log(errors.map((e) => `${e.path} ${e.code}`));

// 2) 取样：不产位图，只看状态
const at = await compute.computeAt(scene, 1_200);          // 毫秒；无活跃单元时 undefined
const range = await compute.computeRange(scene, 900, 1_400); // 只开关心的窗：[900, 1400) 的网格点

// 3) 像素：拿一帧的指纹
const fingerprint = frameFingerprint(bitmap);              // 16 位小写十六进制
const whole = sequenceFingerprint(fingerprints);           // 整段一个值

// 4) 连贯性：匀速不该有尖峰，切镜应该有
const report = continuityReport(frames, { spikeFactor: 3 }); // 缺省 3；阈值 = max(meanDelta * 3, 1)
console.log(report.spikeIndices, report.smoothness);

// 5) 两遍比对：同一次推演跑两遍必须完全一致
const verdict = await auditDeterminism(async () => collectFrames(scene));
if (!verdict.identical) console.log(verdict.mismatches); // 第一处不同 + 上限内全部差异
```

- 旁路哈希：把 `new FrameHasher(downstream)` 当普通 `FrameSink` 传进 `render`，它逐帧记指纹并原样转发，不缓存像素。
- 早停：`render` 的 `onProgress(done, total)` 拿到进度即可中断，不必等整片跑完。
- 直接单测：时间换算（`timestampAt` / `msToFrames` / `frameCount`）、音频组合子、`validate` 都是纯函数，测试文件直接 import 断言，一个引擎都不用建。

## 验证判据

```bash
# 只跑与改动相关的那个文件，不全量跑
pnpm vitest run tests/frame-diagnostics.test.ts       # 指纹 / 差分 / 连贯性 / 两遍比对
pnpm vitest run tests/validate-pool.test.ts           # 干跑检查
pnpm vitest run tests/ledger-timeline.test.ts         # 不建引擎的 fn 单测与同一刻求两次相等
```

已钉住的判据（这些用例真实存在，改动前先跑）：

| 想确认 | 用例 |
| --- | --- |
| 同像素同指纹、改一像素即变、尺寸参与指纹 | `tests/frame-diagnostics.test.ts`「同像素同指纹，改一个像素即变，尺寸参与指纹」 |
| 整段指纹对顺序与长度敏感 | 同文件「整段指纹：序列相同则相同，任一帧不同则不同」 |
| 匀速无尖峰、切镜被识别为尖峰 | 同文件「匀速移动没有尖峰；切镜被识别为尖峰且平滑度变差」 |
| 尺寸不一致报 `spec_violation` | 同文件「尺寸不一致 → spec_violation」 |
| 推两遍逐帧一致 | 同文件「compareFrameHashes 与 auditDeterminism：同一次推演跑两遍必须完全一致」 |
| 越窗被干跑抓到 | `tests/validate-pool.test.ts`「f(90) 越窗：at 越窗 → window_overflow」 |
| 同一刻求两次状态相等 | `tests/ledger-timeline.test.ts`「可计算：同一刻求两次状态相等」 |

## 常见错法

| ✗ 错法 | 为什么错 | ✓ 改成 |
| --- | --- | --- |
| 用 `computeAt(scene, t)` 当「第 t 毫秒一定有一帧」 | 它取 ≤ t 的最近采样点，网格稀疏处会落到更早的点 | 先 `computeRange` 看清网格，再按点取样 |
| 拿 `undefined` 当错误处理漏了 | 时间线尾之后、首网格点之前本来就没有状态 | 显式判 `undefined`，不要当异常 |
| 跨两次 `computeAt` 拼接状态 | 每次调用独立建引擎、独立登记 | 一次 `computeRange` 覆盖整段 |
| 认为 `computeRange` 的 `stepMs` 决定密度 | 点集由采样网格决定，`stepMs` 只是保留参数位 | 要密就调 `fps`，别调 `stepMs` |
| 比 mp4 文件的 SHA | 封装器与时间戳会变，字节不稳定 | 比 `sequenceFingerprint` |
| 指纹比对时混用不同尺寸的帧 | 尺寸先于像素参与散列 | 比对前先对齐尺寸，或用 `frameDelta` 的尺寸校验兜底 |
| `auditDeterminism` 的 `produce` 里复用同一块可变画布 | 两遍会读到互相污染的像素 | 每次 `produce` 都新建画布或先清空 |
| 用 GPU 路径的指纹做跨机器断言 | GPU 只承诺同设备相同 | 跨设备断言只对 CPU 2D 路径成立 |
| 验证一个改动就整片 `render` 或全量跑测试 | 全片与全量都是慢路径；这套库本身可被单测 | 只跑相关测试文件；取样用窄窗 `computeRange`，纯函数直接断言 |

## 边界与陷阱

- **`FrameState` 是 `Record<string, unknown>`**：按 `step` 的 `id` / key 聚合，不是扁平对象。取值前确认 key。
- **`ValidationError.path` 是位置串**：目前实现只填段标识（`段 id`）或 `段/par`，不带单元序号。别把它当稳定主键缓存，报错定位要靠 `code` 与 `message` 一起看。
- **`continuityReport` 的 `smoothness`** 由帧间差分导出；单帧序列返回空 `deltas` 且不报错。
- **`spikeFactor` 必须为正数**，否则抛 `spec_violation`。
- **`RenderError.kind` 四种**：`spec_violation` / `window_overflow` / `step_throw` / `spawn_crash`。验证时按 `kind` 分支，不要只读 `message`。
- **`validate` 不启动运行期状态**，同一剧本可反复校验；它抓不到「画面难看」，只抓结构违约。
