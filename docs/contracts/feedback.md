# 反馈（FrameState / RenderError / ValidationError）

推演对外的三条反馈通道：逐帧回调交出的状态包、推演失败时抛出的错误对象、静态检查逐条返回的问题项。端口在 `packages/contracts/src/feedback/entities.ts`；状态的聚合由 `packages/core/src/domain/simulation/aggregate.ts` 承载，错误由 `packages/core/src/app/runtime/error.ts` 塑形，静态检查由 `packages/core/src/domain/validation/validate.ts` 产出。

## 何时用 / 何时不用

- 用：要让画面和外部共享「这一帧的进度、计数、命中结果」，因为 `step` 回调返回的 `FrameState` 会按 key 合并成全片一份状态包。
- 用：要在出片之外抽某几个时刻的状态，因为 `compute.computeAt` 走的就是同一条聚合路径，只是不进画面。
- 用：要在失败处分支处理（越窗 / 参数非法 / 回调抛错），因为 `RenderError.kind` 是闭集分类，`cursor` 给出出错时的毫秒位置。
- 用：要在推演前一次性拿到全部结构问题，因为 `validate` / `validateScene` 返回 `ValidationError` 数组，空数组即通过。
- 不用：要判断两遍推演是否等价，改用帧指纹那套判据，见 `docs/guides/debug-with-compute.md`。
- 不用：要把宿主侧的绘制结果或帧数带出来，改用 `FrameSink` / `Exporter` 的产物，见 `docs/contracts/capture.md`、`docs/contracts/export.md`。
- 不用：要在帧之间共享可变外部变量来传状态，改用 `FrameState`，因为外部变量不参与确定性，也不进 `lastState`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| `RenderError` 具备 `kind` / `sceneId` / `cursor`，`expected` / `actual` 有值时才挂载 | `makeRenderError("window_overflow", "scene#0", 123, "x", "a", "b")` 后逐字段取到 `"window_overflow"` / `"scene#0"` / `123` 毫秒 / `"a"` / `"b"` | `tests/validate-pool.test.ts` |
| 单元窗口越出本段窗口报 `window_overflow` | 3000 毫秒窗里 `at: env.f(90)`（按 30 帧/秒换算是 3000 毫秒）→ 返回项首项 `code` 为 `window_overflow` | `tests/validate-pool.test.ts` |
| 合法剧本的静态检查结果为空数组 | `validate(scene, 60)` 与 `validateScene(scene)` 都深等于 `[]` | `tests/validate-pool.test.ts`、`tests/ledger-timeline.test.ts` |
| 登记体干跑抛错折成 `spec_violation` 而不是抛出 | 1000 毫秒窗的登记体直接 `throw` → 结果长度 1、首项 `code` 为 `spec_violation` | `tests/validate-pool.test.ts` |
| 参数冲突也是 `spec_violation`，`message` 说清冲突 | `spawn(…, { key, forever: true, duration: 100 })` → `code` 为 `spec_violation`、`message` 含「寿命二义」 | `tests/validate-pool.test.ts` |
| 状态按 `段标识/单元键` 聚合 | 单段 100 毫秒窗 @30 帧/秒 出 3 帧后，`summary.lastState` 的键首项含 `scene#` | `tests/engine-timeline.test.ts` |
| 回调之外操作句柄折成 `spec_violation` | step 窗口外再调 `AudioHandle.stop()` → 抛出对象的 `kind` 为 `spec_violation` | `tests/audio.test.ts` |
| 运行期 spawn 的 setup 失败报 `spec_violation` 并指明场景 | setup 抛错 → 以 `/运行期 spawn 的 setup 失败/` 拒绝 | `tests/spawn-async-setup.test.ts` |
| 同一时刻的状态可以重复取，两次逐字段相等 | `compute.computeAt` 对同一毫秒求两遍，结果深等于 | `tests/ledger-timeline.test.ts` |
| 缺帧来源是明确报错，不是静默空白帧 | 无 painter、绘制目标也无 2D 上下文 → 首帧抛 `name` 为 `SpecViolation` 的错误，导出器一帧未收 | `tests/frame-source.test.ts` |

## 用法

先在不建引擎的前提下把结构问题一次收齐，再决定是否值得推演：

```ts
import { start, validateScene } from "@lingfan-video/core";

const scene = start(1000, (env) => {
  env.step(200, () => undefined);
  // 950 毫秒处再开一个 100 毫秒的单元：200..950 的空档合法，尾部越出 1000 毫秒窗
  env.step(100, () => undefined, { at: 950 });
});

const problems = validateScene(scene);
for (const p of problems) {
  // path 定位到段，code 是机器可读分类，message 给人看
  console.log(p.path, p.code, p.message);
}
```

推演里让回调抛错，错误对象带的是分类与毫秒位置，不是字符串文案：

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";
import type { RenderError } from "@lingfan-video/contracts";

const scene = start(200, (env) => {
  env.step(100, (ctx) => {
    if (ctx.t > 0) throw new Error("画面脚本抛错");
    return { hit: ctx.frameIndex }; // 返回状态包：按 key 聚合
  });
  env.step(100, () => undefined);
});

try {
  await render(scene, {
    fps: 30,
    width: 4,
    height: 4,
    exporter: new FrameSequenceExporter(),
    painter: () => ({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 }),
  });
} catch (error) {
  const err = error as RenderError;
  console.log(err.kind, err.sceneId, err.cursor); // 分类、段标识、出错处的全局毫秒
}
```

## 反例

- ✗ 写法：`catch (e) { if (String(e).includes("window_overflow")) … }` —— 为什么错：文案属于 `message`，措辞会变；机器分类在 `kind` / `code` 上；✓ 改成：`const err = e as RenderError; if (err.kind === "window_overflow") …`。
- ✗ 写法：把 `err.cursor` 当帧号去索引帧数组 —— 为什么错：`cursor` 是全局时间线游标，单位是毫秒；帧号在 `FrameIndex` 上（`ctx.frameIndex`），两者在变帧率下不成比例；✓ 改成：按毫秒定位用 `cursor`，要帧号用 `frameIndex` 或 `msToFrames(cursor, fps)`。
- ✗ 写法：`if (err.expected.length > 0)` 直接读可选字段 —— 为什么错：`expected` / `actual` 是可选项，塑形时只在实参非 `undefined` 时挂载，越窗之外的错误往往没有；✓ 改成：先判 `err.expected !== undefined`，再比较。
- ✗ 写法：只按 `kind` 判断所有失败 —— 为什么错：缺帧来源走的是另一条通道，抛的是 `name` 为 `SpecViolation` 的普通 `Error`，没有 `kind` 字段；✓ 改成：同时看 `kind` 与 `name`，或先判断对象上有没有 `kind`。
- ✗ 写法：在 `env.step` 的返回里塞整个可变对象（如 `return { box }` 后帧间改 `box`）—— 为什么错：聚合按 key 持有你交出的值，帧间复用同一个实例会让历史状态被后续帧改写；✓ 改成：每帧返回新对象，或返回不可变的快照字段。
- ✗ 写法：用 `validateScene` 的空数组代替跑一遍推演 —— 为什么错：静态检查只看结构与池占用，不加载资产、不求值音频、不覆盖运行期抛错；✓ 改成：静态检查通过后再用 `compute.computeAt` 抽几个时刻核对状态。

## 边界与陷阱

- `RenderError.cursor` 的单位是毫秒，指全局时间线游标；不是帧号、不是单元内偏移（单元内偏移是 `ctx.localT`）。
- `expected` / `actual` 是可选项：`makeRenderError` 只在对应实参非 `undefined` 时挂到对象上，省略时这两个键不存在，读之前先判空。
- 四种 `kind` 是闭集：`spec_violation`（违反契约语义）、`window_overflow`（帧窗池超支）、`step_throw`（回调抛错）、`spawn_crash`（spawn 场景崩溃）。
- 有测试钉子的只有 `spec_violation` 与 `window_overflow`；`step_throw` 与 `spawn_crash` 在实现里存在塑形点，但 `tests/` 下没有针对这两个 `kind` 的断言，依赖它们做分支时自己补测试。
- 缺帧来源是独立错误通道：抛出的对象 `name` 是 `SpecViolation`、没有 `kind` 字段，靠 `name` 匹配；它不经过 `RenderError` 的塑形函数。
- `ValidationError.path` 是定位用的段标识；实现侧填的是段 id，并行分支为 `段id/par`。它不是逐节点的 `step#N` 序号，别拿去字符串切分取步号。
- `ValidationError.code` 在静态检查里是机器可读分类；测试覆盖到的是 `window_overflow` 与 `spec_violation` 两种。
- 静态检查的采样密度：`validateScene` 干跑用 60 帧/秒，`validate(scene, fps)` 由调用方给；改 `fps` 会改变 `env.f(n)` 换算出的毫秒，因而越窗结论可能不同。缺省 60 帧/秒。
- `FrameState` 的值类型不做校验（任意值原样聚合），且同一帧内同一键的多次发布是后写覆盖前写；键由聚合器给成 `段标识/单元键`，自己业务字段放值里，不要往键名上编码语义。
- 逐帧交给宿主的是只含本帧活跃键的快照（沉寂的键自然退出）；`RunSummary.lastState` 走的是全表终态，含所有历史发布过的键。两者不要混用。
- `compute.computeAt` 在那一刻没有任何活跃单元时返回 `undefined`，不是空对象。
- 状态包不参与资源释放：想知道某单元是否已进入消亡窗口，读的是 `ctx.disposing` / `ctx.disposeProgress`，不是状态字段。

## 相关

- 端口源码：`packages/contracts/src/feedback/entities.ts`（`FrameState` / `RenderError` / `ValidationError`）
- 相邻页：`docs/contracts/scene.md`（`step` 的返回值、`ctx` 上的只读字段）、`docs/contracts/time.md`（毫秒与帧号的关系）、`docs/contracts/scheduler.md`（消亡窗口与 `kill`）、`docs/guides/debug-with-compute.md`（不整片出片的验证手法）、`docs/pitfalls.md`、`docs/contracts/index.md`
