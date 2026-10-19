# 多幕串联与并行支线

把单幕剧本接成链：`cutTo` 接下一幕、`transitionTo` 声明过场重叠窗、`par` 开并行分支、`loop` 做后台重复、`spawn` 挂并行链、`layer` 声明叠放——能力由剧本 DSL（端口 `Scene` / `SceneEnv`，`packages/contracts/src/scene/entities.ts`）承载，链与时间片由引擎的编译与区间模块（`packages/core/src/domain/simulation/compile.ts`、`packages/core/src/app/runtime/timeline-spans.ts`）实现。

## 何时用 / 何时不用

- **用**：一段画面说不完，需要多幕；过场要真正的叠化/擦除而不是硬切；同一时间窗内要跑两条互不相干的支线；背景要跨幕存活。
- **不用**：单幕单段 → `first-clip.md`；只想确认链总长与帧数、不写画面 → `debug-with-compute.md`；要声音跨幕延续 → `add-audio.md`（声音不因幕边界被自动杀，见该页）。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 硬切时任何时刻只有一段活跃，两段帧不丢不重 | A 500ms + B 400ms → 9 帧 / 900ms | `tests/transition-overlap.test.ts`「两段串行：帧不丢不重，任何时刻只有一段 step 被调用」 |
| 重叠窗内两段同帧求值，总长按共享段扣减 | A 500ms + B 400ms、`overlapMs: 200` → 7 帧 / 700ms | `tests/transition-overlap.test.ts`「两段在窗口内同帧求值，总长按共享段扣减」 |
| 重叠窗内采样网格是两段网格点的并集，无空洞 | `overlapMs: 250` → 时间戳 `[0,100,200,250,300,350,400,450,550]` | `tests/transition-overlap.test.ts`「采样网格在重叠窗内无空洞：时间戳即为并集」 |
| `overlapMs` 为 0 / 负数 / NaN 在登记期即报 `spec_violation` | 抛错文案含 `overlapMs` | `tests/transition-overlap.test.ts`「非法重叠窗：0 / 负数 / NaN 在登记期即报 spec_violation」 |
| 上一幕的 body 返回值就是下一幕的 `prev` | 第二幕拿到首幕返回对象 | `tests/engine-timeline.test.ts`「cutTo 链跑满两段、body 返回值成为下一幕 prev」 |
| `loop` 不推进游标，后续单元仍从登记处开始 | 第二个 `step` 落在 `[200, 400)` 而非 `[2200, 2400)` | `tests/engine-timeline.test.ts`「loop 不推进 cursor：后续 step 仍在 loop 登记处的时间上开始」 |
| 同 key 二次 `spawn` 是续接，不新建一条重叠链 | 链只保留一个实例 | `tests/engine-timeline.test.ts`「同 key 二次 spawn 续接（不重叠新建）」 |
| `layer` 只是声明，占帧窗池的是 `step` | 加层不改变帧数与池消耗 | `tests/layers-decl.test.ts`「是声明：占帧窗池的是 step，不是 layer」 |

## 用法

### 接链与 `prev`

```ts
import { start } from "@lingfan-video/core";

const act1 = start(1000, (env) => {
  env.step(1000, (ctx) => ({ title: `t=${ctx.t}ms` }));
  return { title: "Code Video" }; // body 的返回值 = 下一幕的 prev
});

const act2 = act1.cutTo(2000, (prev, env) => {
  const title = (prev as { title?: string }).title ?? ""; // 承接上一幕
  env.step(2000, (ctx) => ({ text: `${title} :: 主内容 ${ctx.t}ms` }));
  return { title: `${title} 完` };
});

// cutTo 返回的是链尾，render / compute / validateScene 一律从链头 act1 出发
void act2;
```

`start` 与 `cutTo` 的三个重载：

| 写法 | 窗口 | 说明 |
| --- | --- | --- |
| `start(1500, body)` | 1500ms | 两参：窗口毫秒 |
| `start(0, 1.5, body)` | 1500ms | 三参：首参固定写 0，第二参按秒解释（内部 × 1000） |
| `start({ window: 1500, setup, run })` | 1500ms | `StartSpec`：`setup` 在第一帧前跑一次，可返回 Promise |
| `cutTo(2000, body)` | 2000ms | 追加下一幕 |
| `cutTo(0, 2, body)` | 2000ms | 秒糖：首参写 0 标记秒 |

`setup` 可以 `await`（引擎等它完成再构建时间线，所以帧序列仍确定），但**运行期 `ctx.spawn` 的场景在帧内编译**，这类场景的 `setup` 必须同步，否则报 `spec_violation`。`assets` 只在 `setup` 拿得到，`run` 阶段没有。

### 过场：`transitionTo`

```ts
import { start } from "@lingfan-video/core";

const second = start(400, (env) => {
  env.step(400, (ctx) => ({ phase: "b", t: ctx.t }));
});

const first = start(500, (env) => {
  env.step(500, (ctx) => ({ phase: "a", t: ctx.t }));
  env.transitionTo(second, { overlapMs: 200 }); // 省略即硬切
});
```

三段语义要分清楚：

1. **缺省 = 硬切**：本段在收窗处结束，下一段从那里开始，任何时刻只有一段活跃。
2. **给 `overlapMs` = 重叠窗**：下一段提前 `overlapMs` 开始，窗口内两段同时求值、下一段后绘制。两段共享这段时长是唯一代价：**总长 = 两段之和 − overlap**（500ms + 400ms − 200ms = 700ms）。
3. **重叠期间两段各按本地时间推进**：上一段继续走它自己的 `localT`，下一段的 `localT` 从 0 开始。所以下一段回调里 `ctx.localT` 与 `ctx.progress` 都从零起算，全局 `ctx.t` 才对齐。

三层校验（任一条不满足都在登记期或编译期报 `spec_violation`，不会静默退化）：

| 层 | 判据 | 报错文案要点 |
| --- | --- | --- |
| 登记期 | `overlapMs` 必须是 > 0 的有限毫秒数 | `transitionTo 的 overlapMs 必须是 > 0 的有限毫秒数（收到 …）` |
| 编译期 | `overlapMs` 不能吃满本段收窗长度 | `… 重叠窗 500ms 不能吃满整段（本段收窗长度 500ms）` |
| 时间片 | `overlapMs` 不大于下一段长度 | `重叠窗 400ms 不小于本段长度 400ms（下一段会吞掉整段）` |

`transitionTo` 之后的登记在运行期被短路（编译 break），登记本身不抛：可以放心写在 body 末尾。

### 并行分支：`par`

> 伪代码

```ts
env.par([
  (b) => b.step(200, (ctx) => ({ left: ctx.t })),
  (b) => b.step(200, (ctx) => ({ right: ctx.t })),
]);
```

每个分支拿到自己的 `SceneEnv`，显式接进去（不要依赖外层 `this`）。分支同时求值，**占池按最长分支算**：`Σstep + Σwait + Σpar-max`。

### 后台重复：`loop`

> 伪代码

```ts
env.step(200, (ctx) => ({ mark: ctx.t }));
env.loop({ ms: 500, times: 3, fn: (ctx) => void ctx.iteration });
env.step(200, (ctx) => ({ mark: ctx.t })); // 仍从 200ms 起，不是从 loop 结束处
```

- `ms` 省略 = 无固定迭代窗（自管节奏，不占帧窗池），此时 `iterationT` / `iterationProgress` 恒 0，靠 `ctx.next()` 换轮、`ctx.stop()` 提前终结。
- `ms` + `times` 都给了才按次数停；只给 `ms` 就一直重复到幕尾；只给 `times` 不给 `ms` 不占池（`loopPool` 返回 0）。
- `loop` 的内容末点仍计入时间线内容上界——后台出帧一直算到重复结束。
- `loop` 回调里不能 `step`/`loop`/`par`：`LoopContext` 不给这些方法。

### 并行链：`spawn`

```ts
import { start } from "@lingfan-video/core";

const bg = start(400, (env) => {
  env.step(400, (ctx) => ({ frame: ctx.frameIndex }));
});

const main = start(2000, (env) => {
  const handle = env.spawn(bg, { key: "bg", forever: true });
  void handle; // 登记期返回占位句柄：alive 恒 false、localTime/duration 恒 0
  env.step(2000, (ctx) => {
    ctx.scheduler.kill("bg", { fadeOut: 200 }); // 真正的运行句柄与控制面在运行期
  });
});
```

`SpawnOptions`：`key` 必填；`at` 缺省等于登记处；`duration` 缺省等于场景自身时长；`forever` 缺省 false（保活到时间线尾）；`fps` 缺省等于引擎基础帧率。

- 同 key 二次 spawn 是**续接**，不是新建一条重叠链。
- `kill` / `dispose` 可带 `fadeOut`（毫秒），窗口内继续求值并暴露 `disposing` / `disposeProgress`，窗口结束才出池。
- `spawn` 的 `forever` 与 `duration` 同时给是寿命二义，`spec_violation`。
- `duration` 为负同样是 `spec_violation`。

### 层声明：`layer`

> 伪代码

```ts
env.layer({ id: "readout", z: 0, from: 0, to: 1500 });
```

`from` / `to` 相对登记位置，`from` 缺省等于从登记处开始，`to` 缺省等于本段收窗；`z` 缺省按声明顺序，`blend` 缺省普通 alpha 叠放。同一 id 重复登记以最后一处为准。登记不消耗帧窗池、不推进游标。

## 反例

✗ **从 `cutTo` 的返回值去 render**

> 伪代码

```ts
const tail = act1.cutTo(2000, body);
await render(tail, options); // 从链尾出发，前两幕被跳过
```

为什么错：`cutTo` 返回的是链尾节点，而时间线语义要求从链头开始推演。改成从链头：

✓

> 伪代码

```ts
await render(act1, options); // 链头
```

✗ **用 `localT` 算过场遮盖**

> 伪代码

```ts
env.step(1000, (ctx) => ({ cover: ctx.localT / 300 })); // 入幕时从 0 重新起算
```

为什么错：`localT` 是本段起点算起的，切点两侧各读各的零，遮盖会闪一下。切点两侧必须读同一个绝对时刻：

✓

```ts
import { coverProgress } from "@lingfan-video/core";

env.step(1000, (ctx) => ({ cover: coverProgress(ctx.t, 800, 300) }));
```

出幕用返回值作 alpha、入幕用 `1 − 返回值`。

✗ **把 `par` 分支的帧窗当成可叠加的**

> 伪代码

```ts
env.par([
  (b) => b.step(300, fnA),
  (b) => b.step(300, fnB),
]); // 以为池消耗是 600ms
```

为什么错：并行分支共享同一时间窗，池消耗按最长分支算（这里是 300ms）。按 600ms 排版后续单元会让整条链的窗口算错。

✓ 需要串行才叠加：两个 `step` 顺序登记。

## 边界与陷阱

- **总长是编译产物**：`500 + 400 − 200 = 700ms`，不要手写「全片总长」常量。窗口之和减重叠之和就是链长，`durationMs` 会自己给出。
- **重叠窗不吃满、不吞段**：`overlapMs` 必须严格小于本段收窗长度，也必须严格小于下一段长度；等于就报错。
- **硬切下帧不会重**：采样网格是各活跃单元网格点按时戳去重后的并集，同一个时间戳只产一帧，所以「两段各按本地时间推进」不会让帧数翻倍。
- **`wait` 不产帧**：它只推进游标，窗外有其它产帧单元时按网格点回调，纯 `wait` 窗零帧零回调。
- **`spawn` 的登记期句柄是死的**：`alive` 恒 false，`kill` 不做事；要控运行实例必须在 `step` / `loop` 回调里用 `ctx.spawn` 或 `ctx.scheduler`。
- **层的可见区间左闭右开**（`from` 含、`to` 不含）；剧本声明了层而宿主没提供对应 id 的渲染面时报错，不静默少画一层。

## 相关

- 端口源码：`packages/contracts/src/scene/entities.ts`（`Scene` / `SceneEnv` / `TransitionOptions` / `StartSpec`）、`packages/contracts/src/scene/layers.ts`（`LayerDeclaration`）、`packages/contracts/src/scheduler/entities.ts`（`Handle` / `Scheduler` / `SpawnOptions`）；实现见 `packages/core/src/domain/simulation/compile.ts`、`packages/core/src/domain/simulation/dsl.ts`、`packages/core/src/app/runtime/timeline-spans.ts`。
- 示例：`examples/three-acts/main.ts`（三幕 + `spawn` 背景 + `transitionTo` 短路）、`examples/minimal/main.ts`（`par` + `loop` + `layer` + 重叠窗）。
- 相邻页：`first-clip.md`（单幕入口）、`add-audio.md`（跨幕声音）、`export-mp4.md`（出片）、`debug-with-compute.md`（不整片验证链）。
