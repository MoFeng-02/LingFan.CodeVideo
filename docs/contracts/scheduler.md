# 调度器（Scheduler / Handle / SpawnOptions / KillOptions）

运行期的生命周期控制面：把一个已经开出的 spawn 链或一个 step/loop 单元从活跃池里移除，并决定它是立刻消失还是先走一段消亡窗口。端口在 `packages/contracts/src/scheduler/entities.ts`，实现由 `packages/core/src/app/runtime/` 的引擎承载；`ctx.scheduler` 与 `ctx.spawn` 交出的句柄都是它。

## 何时用 / 何时不用

- 用：要在推演途中让一条已经开出的 spawn 链退出，因为退出时刻只有逐帧回调里才知道。
- 用：希望目标在退出前自己画一段消失过程，因为 `fadeOut` 让窗口内继续逐帧求值并交出 `disposing` / `disposeProgress`。
- 用：背景、片尾这类内容要活到时间线尾，因为 `forever` 的终点由总时间线决定，不需要预先写长度。
- 用：多幕之间要延续同一条并行链，因为同 `key` 再次 spawn 是续接而不是新建。
- 不用：要让一段内容按次数重复，改用 `env.loop`，见 `docs/contracts/scene.md`。
- 不用：要在两幕之间做过场，改用 `transitionTo`，见 `docs/guides/compose-acts.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 消亡窗口内目标仍逐帧求值，回调读到 `disposing` 为真、`disposeProgress` 按窗口线性从 0 升到 1 | 窗口 `[100,200)` 毫秒的实例在 150 毫秒处 `disposeProgress` 为 0.5，窗口开始前为 0 | `tests/dispose.test.ts` |
| 不给 `fadeOut` 时 `kill` 立即生效：之后的采样点不再进入该目标 | 子系统帧时间戳列表在 kill 时刻处截断 | `tests/dispose.test.ts` |
| `ctx.dispose({ fadeOut })` 让单元消杀自己，窗口内继续求值 | 自消杀后仍有采样点、`disposing` 为真 | `tests/dispose.test.ts` |
| `scheduler.kill(id)` 按名字消杀 `par` 分支里的另一个单元 | 目标分支停画、其余分支照常 | `tests/dispose.test.ts` |
| 同 `key` 二次 spawn 续接同一实例，不新建并行链 | 300 毫秒 @30fps 的链仍只出 9 帧 | `tests/engine-timeline.test.ts` |
| `forever` 实例活到时间线尾，但不延长主链帧数 | 主链 300 毫秒 @30fps 出 9 帧、时长仍是 300 毫秒 | `tests/engine-timeline.test.ts` |
| spawn 链被 `kill` 后不再绘制，主链帧数按剩余活跃单元算 | 200 毫秒场景只剩 3 个活跃采样点 | `tests/engine-timeline.test.ts` |
| `forever` 与 `duration` 同给即寿命二义 → `spec_violation` | 校验报错 | `tests/validate-pool.test.ts` |
| spawn 的负 `duration` → `spec_violation` | 校验报错 | `tests/validate-pool.test.ts` |
| 登记期的 `env.spawn` 只交出占位句柄，`alive` 为假；真实例在运行期 `ctx.spawn` | 占位句柄 `alive === false` | `tests/dsl-chain.test.ts` |
| 每个 spawn 实例拿到自己的随机子流，同种子可复现 | 同 seed 两实例序列不同且各自稳定 | `tests/random-plane.test.ts` |
| 总线句柄 `kill({ fadeOut })` 在窗口内衰减、窗口结束静音 | 窗口内样本幅度递减、其后为 0 | `tests/audio-graph.test.ts` |

## 用法

登记一条背景链并让它活到时间线尾，主链在 100 毫秒处给它开一个 100 毫秒的消亡窗口：

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";
import type { Handle } from "@lingfan-video/contracts";

const W = 320;
const H = 180;

const bg = start(200, (env) => {
  env.step(200, (ctx) => {
    // 这里有背景自己的绘制；消亡窗口内 ctx.disposing 为真
    void ctx.disposing;
  });
});

let handle: Handle | undefined;
let killed = false;

const main = start(400, (env) => {
  env.step(400, (ctx) => {
    handle ??= ctx.spawn(bg, { key: "bg", forever: true });
    if (!killed && ctx.t >= 100) {
      killed = true;
      handle.kill({ fadeOut: 100 });
    }
  });
});

await render(main, {
  fps: 20,
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

按名字消杀：`scheduler.kill` 的目标可以是句柄、spawn 链的 `key`，或 step/loop 单元的 `id`：

```ts
env.step(400, (ctx) => {
  if (ctx.t >= 200) ctx.scheduler.kill("bg", { fadeOut: 150 });
  if (ctx.t >= 300) ctx.scheduler.killAll(); // 不给 fadeOut = 全部立即出池
});
```

## 反例

- ✗ 写法：`handle.kill({ fadeOut: 0.1 })` 以为 0.1 秒就是 100 毫秒 —— 为什么错：`fadeOut` 的单位是时间线毫秒，0.1 只等于 0.1 毫秒，窗口在一帧内结束，结果是瞬杀；✓ 改成：`handle.kill({ fadeOut: 100 })`。
- ✗ 写法：第二次 `env.spawn(scene, { key: "bg", duration: 500 })` 期望得到一条新实例 —— 为什么错：同 `key` 的第二次 spawn 是续接，参数改动不会新建第二条链；✓ 改成：换一个 `key`，或先 `kill` 旧实例再 spawn。
- ✗ 写法：把 `forever` 当定时器，等它自己停 —— 为什么错：`forever` 只声明寿命到总时间线尾或显式 `kill()`，没有到期时间；✓ 改成：显式 `kill()`，或给 `duration` 定长。
- ✗ 写法：在登记体里保存 `env.spawn(...)` 的返回值并在另一个登记单元里 `kill` —— 为什么错：登记期交出的是占位句柄（`alive` 为假），真实例由运行期 `ctx.spawn` 返回；✓ 改成：在 step/loop/wait 回调里调 `ctx.spawn` 并当场保存句柄。
- ✗ 写法：`killAll({ fadeOut: 100 })` 之后立刻按 `scheduler.alive === 0` 判断已经清场 —— 为什么错：计数含消亡窗口内的实例，窗口结束才出池；✓ 改成：按窗口时长再判，或按回调里的 `disposing` 判。

## 边界与陷阱

- `KillOptions.fadeOut`：时间线毫秒，须大于 0；缺省不传 = 立即死，下一个采样点起不再求值。
- `Handle.kill` 与 `Handle.dispose` 同义，两条路都接受 `KillOptions`；`ctx.dispose()` 是单元消杀自己，走同一个窗口机制。
- 消亡窗口内 `Handle.alive` 仍为真、`Scheduler.alive` 计数仍含该实例；窗口结束才真正出池。
- `disposeProgress` 在窗口外恒为 0；窗口内从 0 线性升到 1。窗口结束即出池，因此回调里读不到 1，最后读到的是小于 1 的值。
- `Handle.localTime`：从 spawn 起算的实例本地时间（毫秒），与 kill 无关；kill 之后仍可读。
- `Handle.duration`：实例时长（毫秒）；`forever` 时语义是总时间线剩余。
- `SpawnOptions.key`：必填。同 `key` 再次 spawn 即续接同一实例；要并行两条链必须给两个 `key`。
- `SpawnOptions.at`：相对登记位置的起播偏移（毫秒），缺省 = 登记处。
- `SpawnOptions.duration`：实例时长（毫秒），缺省 = 场景自身时长；与 `forever` 互斥，同给报 `spec_violation`。
- `SpawnOptions.forever`：寿命 = 总时间线尾或显式 `kill()`；时钟由全局时间线推导，内容播完后按内容时长循环重放。
- `SpawnOptions.fps`：整条链的基础采样密度（帧/秒），链内单元未声明 `fps` 时继承；缺省 = 引擎基础帧率。
- `Scheduler.kill` 的目标三种形态：`Handle`、spawn 链的 `key`、step/loop 单元的 `id`。目标不存在时不报错。
- `Scheduler.killAll`：杀全部活跃的 spawn 实例；给 `fadeOut` 则全部进入同一个消亡窗口。主链（`Scene` 链本身与其中的 step/loop 单元）不在其内，只能按 `id` 逐个消杀。
- 确定性：kill 的时刻由回调读到的 `ctx.t` 决定，同一剧本两次推演在同一采样点发起 kill，帧序列一致。
- 消亡窗口不产生额外采样点：窗口只是让已有采样点继续求值。

## 相关

- 端口源码：`packages/contracts/src/scheduler/entities.ts`
- 单元侧能力：`packages/contracts/src/scene/nodes.ts`（`Disposal`、`ctx.dispose`）
- 相邻页：`docs/contracts/scene.md`、`docs/contracts/audio.md`、`docs/contracts/index.md`
