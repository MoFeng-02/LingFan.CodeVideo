# 剧本（Scene / SceneEnv / StepContext / LoopContext / WaitContext / LayerDeclaration / RandomStream）

用 TypeScript 声明一段「第几毫秒画什么」的能力面：`start` 交出一个不可变的 `Scene`，`cutTo` 把它接成链，登记体里的 `env` 只声明节点，逐帧回调拿到的 `ctx` 按单元类型给不同的能力集。端口在 `packages/contracts/src/scene/entities.ts`、`nodes.ts`、`layers.ts`、`random.ts`；编译与求值由 `packages/core/src/app/runtime/` 承载，入口 `start` 由组合根 `packages/core/src/index.ts` 导出。

## 何时用 / 何时不用

- 用：要把一段画面写成「按采样点求值」的回调，因为 `env.step(duration, fn)` 是唯一产帧的登记方式。
- 用：要把多段串成一条连续时间线，因为 `cutTo` 返回新 `Scene`，总长由链上窗口累加得出。
- 用：要在同一段时间上并行跑几条互不干扰的分支，因为 `env.par` 的分支各有自己的游标进度，且能各自声明层。
- 用：要让一段内容按节奏重复、又不推进主链游标，因为 `env.loop` 后台并行，只提供自己的采样点。
- 用：要在两段之间做重叠过渡而不是硬切，因为 `transitionTo` 的 `overlapMs` 让两段在窗口内同时求值。
- 用：要画面按固定种子可复现地「随机」，因为 `ctx.random` 是数据不是熵。
- 不用：要让一条链活过当前幕、跨段续接，改用 `ctx.spawn` 与 `scheduler`，见 `docs/contracts/scheduler.md`。
- 不用：要加声音、路由总线，改用音频页的能力面，见 `docs/contracts/audio.md`。
- 不用：只想拿状态不进画面，改用 `compute.computeAt`，见 `docs/guides/debug-with-compute.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| `start` 三种重载都只按毫秒定窗口：`start(1000, …)`、`start(0, 1.5, …)`、`start({ window, run })` 分别得 1000 / 1500 / 500 毫秒 | `scene.duration` 三个值逐一相等；`id` 匹配 `scene#` 前缀 | `tests/dsl-chain.test.ts` |
| `cutTo` 返回新 `Scene`，时长与 `id` 都与前一段独立 | `b.duration` 为 300 毫秒且 `b.id !== a.id` | `tests/dsl-chain.test.ts` |
| `setup` 先于 `run` 只跑一次；异步 `setup` 引擎等它完成再建时间线 | 事件序为 `["setup","run"]`，其后 100 毫秒 @60 帧/秒仍出 6 帧 | `tests/dsl-chain.test.ts` |
| 登记期的 `env.spawn` 只交出占位句柄（`alive` 为假），真实例在运行期 `ctx.spawn` | 占位句柄 `alive === false`，`kill` / `dispose` 仍是函数 | `tests/dsl-chain.test.ts` |
| `loop` 后台并行、不推进父游标：其后的 `step` 仍从 loop 登记处的时间开始 | 后续 `step` 窗口落在 `[200, 400)` 毫秒 | `tests/engine-timeline.test.ts` |
| 单元声明 `fps` 覆盖基础帧率，采样点更密但总长不变 | 基础 30 帧/秒、单元 60 帧/秒的 100 毫秒窗口出 6 帧 | `tests/engine-timeline.test.ts` |
| `wait` 只在「同一时刻有别的单元产帧」的网格点上回调，自身不额外产帧 | 20 帧/秒下回调时刻为 0 / 50 / 100 / 150 毫秒，`progress` 为 0 / 0.25 / 0.5 / 0.75 | `tests/wait-update.test.ts` |
| `wait` 能力集不含画布与产帧入口：回调里只能发声、消杀、抽随机 | 回调内 `audio` 与 `scheduler.kill` 可用，音频起播时刻等于该采样点 | `tests/wait-update.test.ts` |
| `layer` 是声明：不占帧窗池、不推进游标 | 有层声明与无层声明两种剧本帧数相等 | `tests/layers-decl.test.ts` |
| 层区间穿过编译与引擎，按绝对故事时间交给宿主；`z` 升序从下往上 | `layers[0]` 为 `{ id: "a", z: 0, from: 100, to: 700 }`；宿主叠放次序为 `[["x"],["y","x"],["x"]]` | `tests/layers-decl.test.ts` |
| 非法层声明在登记期就报错（空 `id` / 空可见区间） | 报错文案分别匹配 `id 不能为空`、`可见区间为空` | `tests/layers-decl.test.ts` |
| 随机是数据：同种子同步数得同一序列，换种子换序列 | 同 seed 两次推演同一串数；不同 seed 不同 | `tests/random-plane.test.ts` |
| `fork(label)` 同 label 同序列，且与父流已抽多少次无关 | 父流先抽若干次后 fork 出的子流序列不变 | `tests/random-plane.test.ts` |
| 重叠过渡窗内两段同帧求值，总长按共享段扣减 | 500 + 400 毫秒两段、`overlapMs` 200 毫秒 → 700 毫秒、7 帧 | `tests/transition-overlap.test.ts` |
| 重叠窗非法值（0 / 负数 / NaN）在登记期即报 `spec_violation` | 报错文案匹配 `overlapMs` | `tests/transition-overlap.test.ts` |

## 用法

一条两幕的链：第一幕画 200 毫秒并声明一层，第二幕用 `cutTo` 接上（硬切）。

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const W = 320;
const H = 180;

const act1 = start(200, (env) => {
  // 登记是声明：不消耗帧窗池、不推进游标
  env.layer({ id: "field", z: 0, from: 0, to: 200 });
  env.step(200, (ctx) => {
    const dx = ctx.progress * W; // 0..1 → 像素
    void dx;
    void ctx.random.float(-1, 1); // [min, max)，同种子同序列
  });
});

const tail = act1.cutTo(300, (prev, env) => {
  void prev; // 上一幕 run/body 的返回值
  env.step(300, (ctx) => {
    void ctx.t; // 全局毫秒
    void ctx.localT; // 本单元内偏移
  });
});
void tail; // cutTo 返回的是链尾：推演一律从链头 act1 出发

// render / compute / validateScene 收的都是链头
await render(act1, {
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
```

把上面 `cutTo` 换成带重叠窗的过渡：`transitionTo` 是**登记体**里的动作（`SceneEnv` 成员），不是 `Scene` 上的方法，所以要在 `start` / `cutTo` 的回调里调，并且它之后同一个登记体里的节点在运行期会被短路。

```ts
const next = start(400, (env) => {
  env.step(400, () => {});
});

const head = start(300, (env) => {
  env.step(300, () => {});
  // 不传 overlapMs 或传 undefined = 硬切：任何时刻只有一段活跃
  env.transitionTo(next, { overlapMs: 100 }); // 100 毫秒重叠窗，窗口内两段同时求值
  env.step(200, () => {}); // 登记不报错，但运行期被短路，不再活跃
});
```

并行分支与循环：分支各有自己的层声明，`loop` 不推进父游标。

```ts
const withBranches = start(400, (env) => {
  env.par([
    (branch) => {
      branch.layer({ id: "bg", z: 0 });
      branch.step(400, () => {});
    },
    (branch) => {
      branch.layer({ id: "fg", z: 10 });
      branch.step(400, () => {});
    },
  ]);
  env.loop({ ms: 100, times: 4, fn: (ctx) => {
    void ctx.iteration; // 0 起
    void ctx.iterationT; // 当前迭代内偏移，毫秒
  } });
});
void withBranches;
```

`env.f(n)` 是单元内的帧号换算糖：`n` 从 0 起，返回毫秒。

```ts
const scene = start(1000, (env) => {
  env.step(1000, () => {}, { at: env.f(0) }); // at 缺省 = 当前 cursor
});
void scene;
```

## 反例

- ✗ 写法：`const h = env.spawn(bg, { key: "bg" }); env.step(100, () => h.kill())` —— 为什么错：登记期拿到的 `env.spawn` 是占位句柄（`alive` 为假），句柄的真实例只能在运行期 `ctx.spawn` 之后拿到，`kill` 占位句柄不会影响任何内容；✓ 改成：在 `step` 回调里 `const h = ctx.spawn(bg, { key: "bg" })`，把 `h` 存进闭包，之后 `h.kill()`。
- ✗ 写法：把 `wait(ms, fn)` 当成「产帧的空档」，在回调里画像素或 `step` —— 为什么错：`WaitContext` 刻意不含 `canvas` / `step` / `loop` / `spawn` / `par`，这段不产帧；若能在空窗里产帧，「空窗不产帧」的导出优化就失真，纯 `wait` 的窗口里回调根本不会被调用；✓ 改成：要画面就 `step`，要「一边等一边更新非画面状态」才用 `wait`，且只在别的单元产帧的采样点上会收到回调。
- ✗ 写法：`loop({ ms: 100, fn })` 之后在同一登记体里继续 `step`，并以为游标被 loop 推进了 —— 为什么错：`loop` 后台并行、不推进父游标，它只贡献自己的采样点；✓ 改成：要串行推进就按顺序 `step` 或用 `cutTo` 接幕，要并行就明确用 `loop` / `par`。
- ✗ 写法：为了「多画一层」在 `step` 回调里调 `env.layer` —— 为什么错：`layer` 属于登记期的 `LayerEnv`，只在登记体里生效；逐帧回调里没有 `layer`，层声明是编译期输入，不是运行期动作；✓ 改成：层在登记体里一次声明完，运行期只按 `ctx` 读数画像素。
- ✗ 写法：`ctx.random.next()` 与别处共享一条流，指望「整体固定种子就整体可复现」—— 为什么错：每个单元实例拿到独立子流，新增/删除一个单元会改变兄弟单元的抽取次数，若共享一条流则整场重新洗牌；✓ 改成：要互不干扰就用 `ctx.random.fork(label)`，同 label 同序列且与父流已抽次数无关。
- ✗ 写法：`transitionTo(next, { overlapMs: 400 })` 在两段各 300 毫秒上 —— 为什么错：`overlapMs` 必须大于 0、不大于本段收窗长度、不大于下一段长度，吃满或超过都会在登记期报错；✓ 改成：取小于两段长度的小值（如 100 毫秒），并接受总长按重叠段扣减。

## 边界与陷阱

- `FrameFn`（`env.f`）的参数是**单元内**帧号（0 起），返回毫秒：`f(n) = n × (1000 / 单元有效帧率)`。单元内语义，跨单元不可比——两个单元的 `f(2)` 一般不是同一毫秒。
- 单元有效帧率三级继承：单元 `StepOptions.fps` > spawn 链 `SpawnOptionsLike.fps` > `RenderOptions.fps`。声明 `fps` 只改采样密度，不改总长。
- `StepOptions` 缺省：`at` 缺省为当前游标；`hold` 缺省 `false`（结束后不再发布状态到本段收窗；给 `true` 则保留最后一帧的值）；`fps` 缺省继承链/基础帧率；`id` 缺省为编译键，只影响 `scheduler.kill(id)` 能否按名字找到它。
- `step(fn)` 单参重载的时长是一个采样步，不是一整段；要定长窗口用 `step(durationMs, fn)`。
- `SceneEnv.fps` 是本段基础采样密度（帧/秒），`SceneEnv.headless` 表示无呈现出片（不建显示面、只求值与编码），两者都在登记期可读。
- `cutTo` 的三参重载 `cutTo(0, windowSec, body)` 用首参字面量 `0` 标记「单位是秒」，因此不能用变量传 0 走秒单位；`start` 的同款重载同理。
- `setup` 只在推演开始前跑一次，可返回 Promise，等待发生在第一帧求值之前、不参与任何帧时序；**例外**：运行期 `ctx.spawn` 的场景在帧内编译，不能等 I/O，其 `setup` 必须同步，否则明确报 `spec_violation`。`assets` 只在 `SetupEnv` 上可读，`run` 阶段拿不到。
- `transitionTo` 的 `overlapMs` 缺省不传 = 硬切（本段在 anchor 收窗、下一段从 anchor 开始，任何时刻只有一段活跃）；给了 = 重叠窗，窗口内两段各自按本地时间推进，下一段 `localT` 从 0 开始。总长 = 两段之和 − overlap。
- `LayerDeclaration` 缺省：`z` 缺省按声明顺序、`blend` 缺省普通 alpha 叠放（`"glow"` 是叠加/光效层，合成行为由宿主实现，引擎不解释像素）、`from` 缺省从登记处开始、`to` 缺省本段收窗。`from` / `to` 相对**登记位置**（与音频 `at`、自动化 `atMs` 同一约定），不是绝对时间线时刻。同 `id` 重复登记以最后一处为准。
- `LayerDeclaration.id` 是剧本与宿主之间唯一的配对键：宿主按 `id` 找面，剧本声明了层而宿主没给面对应的面会明确报错，不静默少画一层。
- `LoopSpec` 缺省：`ms` 省略 = 无固定迭代窗（`fn` 自管 `next()` / `stop()`，`iterationProgress` 恒 0）；`times` 省略 = 不按次数停（铺到时间线尾或被 `stop()`）；`fps` / `id` 缺省同 `StepOptions`。
- `WaitContext` 不含 `canvas` / `step` / `loop` / `spawn` / `par`，只给 `t` / `frameIndex` / `totalTime` / `input` / `localT` / `duration` / `progress` / `scheduler` 与环境类（音频、随机、消亡、`once`）。`WaitOptions.id` 缺省为编译键。
- `OnceScope` 缺省 `"unit"`：该 step/loop 单元（含 loop 的全部迭代）只发一次；`"iteration"` 每轮一次、`"spawn"` 每实例一次（`key` 作实例 id）、`"scene"` 整场一次。`once` 只做事件，不产帧。
- `RandomStream` 边界：`next()` 是 `[0,1)`；`float(min,max)` 是 `[min,max)` 且要求 `max > min`；`int(min,max)` 是 `[min,max)` 内的整数且要求整数、`max > min`；`chance(p)` 的 `p` 取 0..1；`pick(items)` 要求非空数组。越界在调用点报错（文案含 `max > min` / `0..1` / `非空`）。
- `DEFAULT_PROGRAM_SEED` 是 `RenderOptions.seed` 的缺省值；非法种子（负数 / 小数 / 超 32 位 / NaN）在开工前就报 `spec_violation`，不进入推演。
- `StepContext.input` 是那一刻已生效事件的快照（`atMs ≤ t` 的事件已生效），同帧所有单元共享同一份，不能被改写。
- 单位自查：`duration` / `at` / `localT` / `iterationT` / `t` / `totalTime` / `deltaTime` / `from` / `to` / `overlapMs` / `f(n)` 返回值都是毫秒；`iteration` / `frameIndex` 是帧（整数）；`fps` 是帧/秒；`progress` / `iterationProgress` / `chance` 的入参是 0..1、无量纲；`z` 是无量纲叠放次序；`width` / `height` 是像素。

## 相关

- 端口源码：`packages/contracts/src/scene/entities.ts`（`Scene` / `SceneEnv` / `SetupEnv` / `StartSpec` / `FrameFn` / `CanvasEnv` / `TransitionOptions`）、`packages/contracts/src/scene/nodes.ts`（`StepContext` / `StepOptions` / `LoopContext` / `LoopSpec` / `WaitContext` / `WaitOptions` / `OnceScope` / `Disposal`）、`packages/contracts/src/scene/layers.ts`（`LayerDeclaration` / `LayerEnv`）、`packages/contracts/src/scene/random.ts`（`RandomStream` / `DEFAULT_PROGRAM_SEED`）
- 相邻页：`docs/contracts/time.md`（毫秒与帧号的关系）、`docs/contracts/feedback.md`（`FrameState` 与 `RenderError`）、`docs/contracts/scheduler.md`（`spawn` / `kill` / `forever`）、`docs/contracts/audio.md`（`env.audio` / `bgm` / 总线）、`docs/contracts/index.md`
