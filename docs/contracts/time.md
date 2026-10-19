# 时间（Clock / Ms / FrameIndex / timestampAt）

时间线的只读坐标面：任一次推演在任一采样点上的时刻、帧号、总长与步长，以及帧号与毫秒之间那条只能乘不能加的关系。端口在 `packages/contracts/src/time/ports.ts`（`Clock`）与 `packages/contracts/src/shared/units.ts`（`Ms` / `FrameIndex`）；换算函数由组合根 `packages/core/src/index.ts` 导出，实现落在 `packages/core/src/domain/time-math/time-math.ts`。

## 何时用 / 何时不用

- 用：逐帧回调里要拿「现在是什么时候」，因为 `ctx.t` 就是全局时间线的毫秒坐标。
- 用：要把单元内第 n 帧换算成毫秒，因为 `env.f(n)` 与 `timestampAt(i, fps)` 是同一套逐帧乘法。
- 用：要判断整条时间线还剩多久，因为 `ctx.totalTime` 是总长（毫秒），不是入参。
- 用：要做单元内的进度映射，因为 `ctx.localT` 从本段起点算起，`ctx.progress` 是它的 0..1 归一。
- 用：要在出片之外复算某个时刻，因为 `timestampAt` / `msToFrames` 是纯函数，不依赖引擎。
- 不用：想知道「已经跑了多少帧」，改用 `ctx.frameIndex`（全局采样点序号）。
- 不用：要按播放器时钟驱动画，改用预览端的实时时钟实现，见 `docs/guides/export-mp4.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 帧号→毫秒是逐帧乘法，不是累加 | `timestampAt(30, 30)` 得 1000 毫秒、`timestampAt(1, 30)` 约 33.3333 毫秒；30 次累加 `1000 / 30` 只得约 999.9 毫秒，与乘法不等 | `tests/time-math.test.ts` |
| 毫秒→帧号向下取整，且与逐帧乘法互为逆运算 | `msToFrames(ms, fps) === Math.floor(ms * fps / 1000)`；`framesToMs` 与 `timestampAt` 结果恒等 | `tests/time-math.test.ts` |
| `fps` 只决定采样密度：调高只加采样点，不改同一时刻上的语义 | 同一段 100 毫秒窗口，基础 30 帧/秒出 3 帧，单元声明 60 帧/秒出 6 帧 | `tests/engine-timeline.test.ts` |
| 采样点是各活跃单元网格点的并集，时间戳严格递增 | 两段以 250 毫秒重叠窗拼接后时间戳为 0 / 100 / 200 / 250 / 300 / 350 / 400 / 450 / 550 毫秒，无重复无空洞 | `tests/transition-overlap.test.ts` |
| 没有活跃单元的窗口不产帧 | 空剧本 150 毫秒出 0 帧；只含 `wait` 的窗口零帧零回调 | `tests/engine-timeline.test.ts`、`tests/wait-update.test.ts` |
| 总时长是编译产物：各段窗口之和减重叠窗 | 500 毫秒 + 400 毫秒两段、重叠 200 毫秒，`durationMs` 为 700 毫秒 | `tests/transition-overlap.test.ts` |
| 时间读数只读：同一时刻取两次结果相等 | `computeAt` 在同一毫秒求两次，状态逐字段相等 | `tests/ledger-timeline.test.ts` |

## 用法

先确认一次推演的帧数与总长，再用纯函数复算首末两帧的时刻：

```ts
import { render, start, timestampAt, msToFrames } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const W = 320;
const H = 180;

const scene = start(200, (env) => {
  env.step(200, (ctx) => {
    // 采样点上的时间读数，单位全是毫秒
    void ctx.t; // 全局时间线毫秒
    void ctx.localT; // 本单元内偏移，从本段起点算起
    void ctx.totalTime; // 整条时间线总长
    void ctx.deltaTime; // 1000 / 本单元有效帧率
    void ctx.frameIndex; // 全局采样点序号，0 起
    void ctx.fps; // 本单元有效帧率，帧/秒
  });
});

const result = await render(scene, {
  fps: 30,
  width: W,
  height: H,
  painter: () => ({
    data: new Uint8ClampedArray(W * H * 4),
    width: W,
    height: H,
  }),
  exporter: new FrameSequenceExporter(),
});

// 帧号 ↔ 毫秒：同一套乘法，不受引擎状态影响
console.log(timestampAt(30, 30)); // 1000 毫秒
console.log(msToFrames(1000, 30)); // 30 帧
console.log(result.frames, result.durationMs);
```

单元自己声明采样密度时，`deltaTime` 随之变；单元内帧号只从 `env.f` 进，不从 `ctx.frameIndex` 进：

```ts
const dense = start(200, (env) => {
  env.step(
    200,
    (ctx) => {
      void ctx.deltaTime; // 约 16.667 毫秒 = 1000 / 60
    },
    { fps: 60 },
  );
  // f(n) 的 n 是单元内帧号（0 起），不是全局 frameIndex
  const thirdFrameMs = env.f(2); // 约 33.333 毫秒
  void thirdFrameMs;
});
void dense;
```

## 反例

- ✗ 写法：`let t = 0; env.step(300, () => { t += 1000 / 30; })` 自己累加时间 —— 为什么错：帧/秒不整除时累加与乘法会分叉（30 次累加得约 999.9 毫秒，乘法得 1000 毫秒），而且累加出来的时刻不属于采样网格；✓ 改成：读 `ctx.t`（全局）或 `env.f(n)`（单元内），要算别处用 `timestampAt(frameIndex, fps)`。
- ✗ 写法：`const frames = durationMs / 1000 * fps` 直接拿浮点当帧数 —— 为什么错：帧号是整数索引，毫秒换帧必须向下取整，否则末尾不满一帧的窗口会多算一个采样点；✓ 改成：`msToFrames(ms, fps)`。
- ✗ 写法：把 `ctx.frameIndex` 当「本单元第几帧」，再乘单元 `deltaTime` 当本地时间 —— 为什么错：`frameIndex` 是全局采样点序号，变采样密度下与 `t` 不是均匀映射，单元内帧号只在 `FrameFn` 的入参里；✓ 改成：单元内的帧号语义用 `env.f(n)`，单元内时间读数用 `ctx.localT`。
- ✗ 写法：为了「更平滑」把 `fps` 从 30 改到 60，并指望同一时刻的 `ctx.t` 也变 —— 为什么错：`fps` 只决定采样密度，同一毫秒上的时间语义不变，变的只是采样点更密；✓ 改成：时间语义从 `ctx.t` 读，密度从 `fps` 调，两者分开处理。
- ✗ 写法：把 `deltaTime` 当「上一帧到这一帧的实际耗时」用来做物理积分 —— 为什么错：它恒等于 `1000 / fps`（本单元有效帧率），是理论步长；✓ 改成：要固定步长积分就用 `deltaTime`，要真实耗时是另一件事，本仓不提供。

## 边界与陷阱

- `Ms` 是毫秒数的类型别名，引擎内全部时间值都用它；`FrameIndex` 是帧号（0 起）。两者在类型层都是 `number`，互相传错不会被拦下，靠单位和命名区分。
- `Clock` 的五个字段由实现方（引擎）填充：`t`（当前时间线时刻，毫秒，全局坐标）、`frameIndex`（当前采样点帧号，0 起）、`totalTime`（整条时间线总长，毫秒）、`fps`（当前采样点有效帧率，帧/秒）、`deltaTime`（当前采样步长，毫秒）。契约只声明形状，仓内没有直接钉这五个字段的测试，数值语义由 `timestampAt` 与采样网格相关测试间接钉住（见断言表）。
- `deltaTime` 恒等于 `1000 / fps` 毫秒，且 `fps` 是**本单元有效帧率**：单元 `fps` > spawn 链 `fps` > `RenderOptions.fps` 三级继承。因此同一采样点在不同单元里读到的 `deltaTime` 可能不同。
- `timestampAt` 只承诺逐帧乘法 `timestampAt(i, fps) === i * (1000 / fps)`；它不取整、不保证帧号连续。取整只发生在 `msToFrames`，而 `frameCount` 是 `msToFrames` 的别名。
- 变帧率下 `frameIndex` 与 `t` 不是均匀映射：同样的帧号差，在不同单元上可能对应不同的毫秒差。
- `totalTime` / `RenderResult.durationMs` 是编译产物，不是设计参数：总长 = 链上窗口累加 − 重叠窗，没有「全片总长」这个可写字段。
- 空窗不产帧：只有 `wait` 的区间没有采样点，那些毫秒上不存在帧，也就不存在对应的 `frameIndex`。
- `fps` 的单位是帧/秒，是采样密度，不是播放速度；改它不会让同一部片子「变快或变慢」。
- 导出端装配确定性时间线实现，预览端可以换成实时时钟实现——两种实现的字段一致，但只有确定性实现承诺逐帧可复现。
- 单位自查：`t` / `localT` / `totalTime` / `duration` / `deltaTime` / `timestampAt` 返回值都是毫秒；`frameIndex` / `msToFrames` / `frameCount` 是帧（整数）；`fps` 是帧/秒；`progress` 是 0..1、无量纲。

## 相关

- 端口源码：`packages/contracts/src/time/ports.ts`（`Clock`）、`packages/contracts/src/shared/units.ts`（`Ms` / `FrameIndex`）
- 换算实现：`packages/core/src/domain/time-math/time-math.ts`（`timestampAt` / `msToFrames` / `framesToMs` / `frameCount`）
- 相邻页：`docs/contracts/scene.md`（采样网格由哪些单元贡献）、`docs/contracts/scheduler.md`（`Handle.localTime` 的起算点）、`docs/mental-model.md`（时间相关的不变量）、`docs/contracts/index.md`
