---
name: codevideo-schedule
description: 多幕链的拼接与生命周期：cutTo / transitionTo 的过场、par 的并行分支、loop 的自管节奏、spawn 的并行链与 key 续接、layer 的叠放声明、scheduler 消杀与消亡窗口。Use when joining acts into a chain, handling transitions between acts, running branches concurrently, or controlling spawned timelines.
metadata:
  version: "2.0.0"
---

# 多幕链与并行

一条链 = 首幕（`start`）+ 若干 `cutTo` / `transitionTo`。**总时长是编译产物**：链跑完才知道总长。项目思维：时间不是一张表，是一条链——每幕只知道自己的窗口和上一幕的返回值；并行不是另一条时间轴，是同一时间线上的多条链。

## 何时用 / 何时不用

- 用：拼接多幕、写幕间叠化或擦除、开并行分支、控制 spawn 实例的寿命、声明层与叠放次序、运行期消杀。
- 不用：只写一段幕内的逐帧画面 → `codevideo-scene`；要发声 → `codevideo-audio`。

## API 面备查（签名以源码为准）

| 你要 | API | 要点 |
| --- | --- | --- |
| 追加一幕（硬切） | `scene.cutTo(windowMs, (prev, env) => {...})` | 返回**新链**，不改旧链；回调返回值成为下一幕的 `prev` |
| 秒糖 | `scene.cutTo(0, 2.5, body)` | 首参字面量 `0` 是单位标记；2.5 = 2500ms |
| 幕间过渡 | `env.transitionTo(next, { overlapMs })` | 后段提前 `overlapMs` 开始；重叠窗内两段都在求值、后段后绘制 |
| 并行分支 | `env.par([b => ..., b => ...])` | 每分支独立 `SceneEnv`；共享本幕窗口 |
| 循环节奏 | `env.loop({ ms?, times?, fn, fps?, id? })` | 后台并行、不推进父游标；`LoopContext.next()`/`stop()` 自管；`iteration`/`iterationT`/`iterationProgress` 可读 |
| 并行链 | `env.spawn(scene, { key, at?, duration?, forever?, fps? })` | 返回 `Handle`；同 key 续接同一实例 |
| 登记层 | `env.layer({ id, z?, blend?, from?, to? })` | `from`/`to` 相对登记位置；同 id 最后声明为准；z 升序在下、同 z 看声明顺序 |
| 消杀 | `scheduler.kill(target, { fadeOut? })` / `ctx.dispose({ fadeOut? })` | 幂等：目标不存在静默返回；`killAll` 只杀 spawn 链，主链只能按 id 逐个杀 |

关键缺省值：`spawn.at` 缺省 = 登记处（相对登记位置，非绝对时间）；`spawn.duration` 缺省 = 场景自身窗口；`forever: true` = 铺到总时间线尾或显式 kill；`LayerDeclaration.from/to` 缺省 = 登记处到本段收窗；`overlapMs` 必须满足 `> 0`、`≤ 本段收窗`、`≤ 下段窗口`（三层校验，编译期报错）。

`LoopSpec` 省略 `ms` = 无固定迭代窗，fn 用 `next()`/`stop()` 自管节奏；`ms` + `times` 都给才按次数停。

## 硬约束

1. **总长 = 各幕窗口之和 − 各重叠窗**。没有「全片总长」入参；想要特定总长只能调窗口。
2. **重叠窗三层校验**（`> 0` / `≤ 本段收窗` / `≤ 下段窗口`）不满足即编译期报错；重叠期两段各自按本地时间推进，不存在共享时钟。
3. **`cutTo` 返回新链，不改旧链**（不可变）。
4. **`par` 分支登记互不可见**；同一 key 的 spawn 仍全局去重。
5. **`loop` 不推进父游标**——它后台并行；父游标只被 `step` / `wait` / `par` 推进。
6. **`layer` 只是声明**：不推进游标、不占帧窗池；叠放由 `z` 决定。
7. **同 `key` 再次 `spawn` = 续接同一实例**，不是新建。

## 骨架

```ts
import { start } from "@lingfan-video/core";

const first = start(800, (env) => {
  env.layer({ id: "hud", z: 10 });                 // 声明层：宿主按 id 注入渲染面
  env.step(800, (ctx) => drawBackdrop(ctx));
});

const second = first.cutTo(600, (prev, env) => {
  env.step(600, (ctx) => drawCard(ctx));
  return { from: "first" };                        // 返回值成为下一幕的 prev
});

const third = second.cutTo(500, (prev, env) => {
  env.par([
    (b) => b.step(500, (ctx) => drawForeground(ctx)),
    (b) => b.loop({ ms: 250, times: 2, fn: (ctx) => drawPulse(ctx) }),
  ]);
  env.spawn(grain, { key: "grain", forever: true }); // 保活：铺到链尾、内容循环重放
});

// 叠化：后段提前 150ms 开始，总长 = 500 + 400 − 150 = 750ms
const fourth = third.cutTo(400, (prev, env) => {
  env.step(400, (ctx) => drawFourth(ctx));
  env.transitionTo(fifth, { overlapMs: 150 });
});
```

运行期生命周期组合（写在 step/loop 回调里）：

```ts
env.step(2000, (ctx) => {
  const h = ctx.spawn(ring, { key: "ring", at: 300 }); // at 相对登记位置
  if (ctx.localT > 1200) h.kill({ fadeOut: 400 });      // 消亡窗口：仍逐帧求值 400ms
  ctx.dispose({ fadeOut: 300 });                        // 本单元自带消亡：回调读 disposing
});
```

消亡窗口内回调可读 `ctx.disposing`（boolean）与 `ctx.disposeProgress`（0..1），自己画消失过程；窗口结束才真正出池。

## 验证判据

```bash
pnpm vitest run tests/dsl-chain.test.ts tests/transition-overlap.test.ts tests/layers-decl.test.ts
```

- 总长：`render` 返回的 `durationMs` 等于手算的「窗口和 − 重叠和」。
- 重叠：重叠窗内两段都被求值，共用的采样点是两段网格的并集。
- 层：同 `id` 后声明覆盖前声明。

## 常见错法

| ✗ 错法 | 为什么错 | ✓ 改成 |
| --- | --- | --- |
| 先把各幕窗口加起来算总长，再写调度 | 总长是编译产物，写死即绕开链 | 让链自己算；要提前知道用 `compute.computeRange` 或渲染后读 `durationMs` |
| `overlapMs` 给得比收窗还大 | 违反三层校验，编译期报错 | 保证 `overlapMs ≤ min(本段收窗, 下段窗口)` |
| 在重叠区写「谁当前活跃」的绝对时间判断 | 两段同时活跃，不存在唯一活跃段 | 各段读自己的 `ctx.localT` / `ctx.progress` |
| 幕边界手动 `handle.kill()` 收声音或画面 | 引擎不因幕边界自动杀；手动补刀让因果散落 | 用 `forever: true` 保活，或 `dispose` 时收 |
| 在 `par` 分支里改共享 `let` 变量 | 分支求值顺序不是契约，结果随实现变 | 各自返回值，按 key 聚合成 `FrameState` |
| 用 `setInterval` / `setTimeout` 做节奏 | 脱离采样网格，产物不可复现 | `loop` 的 `ms` + `times`，或 `step` 里按 `ctx.t` 算 |

## 边界与陷阱

- **`spawn` 的 `at` 相对登记位置**，不是绝对时间。
- **`forever: true`** 的实例活到总时间线尾，内容播完循环重放；不是「无限新建」。
- **保活实例的帧窗池**一直占到链尾，总帧数因此变多——这是编译期的账，不是运行期补帧。
- **消亡窗口**：`kill({ fadeOut })` / `dispose({ fadeOut })` 期间仍逐帧求值，`disposing` / `disposeProgress`（0..1）可读，窗口结束才出池。
- **运行期 `ctx.spawn` 的场景 setup 必须同步**，否则 `spec_violation`（它在帧内编译，不能等 I/O）。
- **`scheduler.killAll` 只杀 spawn 链**：主链（`Scene` 链本身及其 step/loop 单元）不在其内，只能按 `id` 逐个消杀——一次调用就让余下时间线不再产帧是设计禁止的。
