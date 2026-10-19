# 声音：声明、运行期发射与去重

声音有两条登记路径——登记期的 `env.audio` / `env.bgm` / `env.synth` 加图声明 `env.bus` / `env.send` / `env.duck` / `env.automate`，运行期的 `ctx.audio` / `ctx.synth` / `ctx.bus`——能力由 `AudioEnv`、`AudioGraphEnv`、`OnceEnv`（`packages/contracts/src/scene/nodes.ts`）与音频端口（`packages/contracts/src/audio/ports.ts`、`graph.ts`）承载，确定性混音由适配器 `OfflineAudioMixer`（`packages/infra/src/audio/offline-mixer.ts`）实现。

## 何时用 / 何时不用

- **用**：要在幕里加音乐/音效/程序化声部；声音要随分支或运行期条件触发；要总线、发送、侧链压低与参数轨迹；同一事件只想响一次。
- **不用**：画面切分 → `compose-acts.md`；只想验证声音程序而不推演帧 → `debug-with-compute.md`（`compileAudioProgram`）；要把声音封进 mp4 → `export-mp4.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 登记期 `at` 相对登记位置；运行期 `at` 是相对发射时刻的延迟 | 100ms 处发射 + `at: 200` → 起播 300ms | `tests/audio-emit-delay.test.ts`「at 相对发射时刻：t=100 发射 + at 200 → 起播 300」 |
| 两种 `at` 语义并存，不互相覆盖 | 同场景里登记期 `at: 100` → 100ms，运行期 `at: 200` → 300ms | `tests/audio-emit-delay.test.ts`「登记期 at 仍相对登记位置（两种语义并存）」 |
| 负 `at` 按 0 钳，声音不落到时间线之前 | `at: -100` → `startMs === 0` | `tests/audio-emit-delay.test.ts`「负 at 按 0 钳（不落到时间线之前）」 |
| 句柄操作按求值时刻记进 `voice.ops` | `setGain(1, 50)` / `setRate(2, 0)` / `stop(100)` 三条 op | `tests/audio.test.ts`「句柄操作记录到 voice.ops（stop / setGain / setRate，时刻=求值时刻）」 |
| 回调之外操作句柄报 `spec_violation` | 泄漏句柄在推演结束后调 `stop()` 抛错 | `tests/audio.test.ts`「回调之外操作句柄报 spec_violation（操作面只在 step/loop 窗口内有效）」 |
| `ctx.once` 缺省作用域 `unit`：整个单元窗口只发一次 | 400ms 的 step @20fps → 8 帧、声音 1 条 | `tests/once.test.ts`「unit：整个 step 窗口只发一次（默认作用域）」 |
| `iteration` 作用域：`loop` 每轮一次 | 350ms 窗、`ms: 100` → 4 次 | `tests/once.test.ts`「iteration：loop 每轮一次」 |
| `spawn` 作用域：每个实例一次，`forever` 重放不重复 | 两个 key → 2 条声音 | `tests/once.test.ts`「spawn：每个实例一次，forever 重放不重复」 |
| 声音进总线后按总线增益缩放 | `ctx.bus("fx", { gain: 0.5 })` + 声音入 `fx` → 样本为原值一半 | `tests/audio-graph.test.ts`「运行期懒建总线：ctx.bus 后运行期声音按总线增益」 |
| 侧链：源总线起声时压低目标总线，释放后恢复 | `duck` 窗口内目标总线衰减、窗口后回升 | `tests/audio-graph.test.ts`「触发总线发声时压低目标总线，释放后恢复」 |
| 参数轨迹到点生效，缺省立即改，此前保持前一值 | `automate` 折点前保持、折点后为新值 | `tests/audio-graph.test.ts`「到点生效：缺省立即改参数，此前保持前一值」 |
| `fadeOut` 贴声音实际终点倒算，源播完处归零 | 500ms 源 + `fadeOut(200)` → 尾部线性降到 0 | `tests/envelope.test.ts`「fadeOut(200) 贴声音实际终点倒算（源 500ms 播完处归零）」 |
| `{ db }` 记法在写入时间线前折算成线性幅度 | 登记期 dB 增益落成线性值 | `tests/gain-units.test.ts`「登记期声音的 dB 增益落成线性幅度」 |

## 用法

### 登记期：声明与图

```ts
import { clip, gain, loop, fadeIn, rate } from "@lingfan-video/core";

const scene = start(2000, (env) => {
  // 拓扑先声明：bus 重复登记同 id = 覆盖规格（最后声明为准）
  env.bus({ id: "music", gain: 0.8 });
  env.bus({ id: "hall", effects: [{ kind: "reverb", roomSize: 0.8, mix: 0.4 }] });
  env.send({ from: "music", to: "hall", amount: 0.3 }); // amount 0..1
  env.duck({ from: "sfx", to: "music", amountDb: 6 }); // 侧链

  // 音乐：bgm 是 audio + 循环到时间线尾的糖
  env.bgm(clip("pad"), { gain: gain(0.5), bus: "music", rate: rate(1) });

  // 一次性音效：起点 = 登记位置 + at
  env.audio(clip("blip"), { at: 400, gain: gain(0.6), pan: -0.4 });

  // 程序化声部：起点 = 当前登记位置（无 at 选项）
  env.synth({ wave: "sine", freq: 440, durationMs: 300, gain: 0.3 });

  // 参数轨迹：时刻相对本段起点
  env.automate({ bus: "music", points: [{ atMs: 800, gain: 0.3, rampMs: 400 }] });

  env.step(2000, () => undefined);
});
```

声明面的要点：

| 入口 | 起点 | 说明 |
| --- | --- | --- |
| `env.audio(clip, options?)` | 登记位置 + `at` | `at` 缺省 0，即从登记处起播；不推进游标、不占帧窗池 |
| `env.bgm(clip, options?)` | 登记位置 + `at` | `loop` 由糖固定为「铺到时间线尾」，参数类型是 `Omit<AudioOptions, "loop">` |
| `env.synth(spec)` | 当前登记位置 | 无 `at`，返回 `void` |
| `env.bus(spec)` | — | 只定拓扑（父子关系），运行期改参数走 `ctx.bus(id)` |
| `env.send({ from, to, amount, pre? })` | — | `amount` 0..1；`pre` 缺省 false，即 post-fader |
| `env.duck(rule)` | — | `amountDb` 为正；`attackMs` 缺省 10ms、`holdMs` 缺省 0ms、`releaseMs` 缺省 200ms、`thresholdDb` 缺省 −30dBFS |
| `env.automate({ bus, points })` | — | `atMs` 相对本段起点且严格递增；`rampMs` 缺省立即生效 |

### 运行期：发射与改参数

> 伪代码

```ts
env.step(2000, (ctx) => {
  if (ctx.t !== 600) return;
  const h = ctx.audio(clip("tick"), { bus: "music", gain: gain(0.7) });
  h.setGain({ db: -6 }, 100); // 100ms 内线性过渡到 −6dB
  h.setRate(1.5, 200); // 1.5 倍速（同时是 1.5 倍音高）
  h.stop(300); // 300ms 内淡出
  ctx.bus("music").gain(0.4, 200); // 总线参数同样带过渡
});
```

`AudioHandle` 三件事：`stop(fadeOutMs?)`（缺省立即）、`setGain(value: GainLike, rampMs?)`（`GainLike` 是线性幅度或 `{ db }`）、`setRate(value, rampMs?)`（须 > 0 的有限数，禁倒放与静止）。另有只读的 `id` / `startedAtMs` / `alive`。

- 操作以**当前求值时刻**为生效时刻，都记进 `voice.ops`，导出端据此复算。
- 回调之外调用是「没有时间轴依据的操作」，直接报 `spec_violation`。
- 声音的寿命到三处之一结束：源播完、`stop()`、总时间线尾。**不因幕/段/链边界自动消失**——跨幕持续要靠它，不需要手动续期。

### `ctx.once`：四种去重作用域

> 伪代码

```ts
env.loop({ ms: 100, fn: (ctx) => ctx.once("iteration", (c) => c.audio(clip("tick"))) });
```

| 作用域 | 去重粒度 | 典型用法 |
| --- | --- | --- |
| `"unit"`（缺省） | 该 step/loop 单元整个窗口只发一次 | 进场的提示音 |
| `"iteration"` | `loop` 内容每轮一次 | 节拍器 |
| `"spawn"` | 每个 spawn 实例一次（`forever` 重放不重复） | 背景链的开场音 |
| `"scene"` | 整场一次（跨多个单元） | 片头主题 |

`OnceContext` 只给 `audio` 与 `dispose`：去重的语义是「事件」，不是「产帧」，所以拿不到画布、也拿不到 `step`。去重键由作用域 + 场景 id + 宿主键推出，不含随机数与墙钟，因此「第一次到这一步」是确定的。

### `at` 的两套语义

一处写 `at`，两处含义，必须分清：

- **登记期**（`env.audio` / `env.bgm`）：`at` 相对**登记位置**。`at: 100` 写在 300ms 处的节点上，起播就是 400ms。
- **运行期**（`ctx.audio`）：`at` 相对**发射时刻**的延迟。在 100ms 那帧发射、`at: 200`，起播 300ms。

两套语义并存，同一个场景里各用各的。负值一律按 0 钳。

### 组合子

`clip` / `gain` / `pan` / `loop` / `rate` / `warp` / `ramp` / `curve` / `fadeIn` / `fadeOut` 只造值、不加载素材，非法输入在构造期抛 `spec_violation`：

- `gain(value, env?)`：`value` 是线性幅度或 `{ db }`；`env` 可带 `fadeIn` / `fadeOut`（毫秒）与整段包络。
- `ramp(from, to, ms)`：局部 0 → `from`，`ms` → `to`，其后保持。`ramp(1, 0, 300)` 是 300ms 降到静音。
- `curve(points)`：折点时间须严格递增，首折点前取首值。
- `fadeOut(ms)`：折点按「距终点」标记，终点由源播完 / `stop()` / 时间线尾决定，不需要预先知道时长。
- `rate(v)`：`v` 须 > 0；`warp(...points)`：每项 `[时间线毫秒, 源毫秒 | "end"]`，锚点时间严格递增、源位置递增。

包络与基础增益**相乘**，不是相加。

## 反例

✗ **在 `setup` 之外靠墙钟排声音**

> 伪代码

```ts
setTimeout(() => player.play(), 500);
```

为什么错：声音必须是时间线的一等对象，否则导出端（离线混音）根本拿不到这条声音，预览与导出会不一致。改成登记或运行期发射：

✓

> 伪代码

```ts
env.audio(clip("blip"), { at: 500 });
```

✗ **用幕边界的手动 `stop` 收尾**

> 伪代码

```ts
env.audio(clip("bed")); // 以为下一幕构造时会自动停
```

为什么错：声音不因幕/段/链边界自动杀，它会在整段时间线里继续播。要收就显式给 `stop`，或给它一个终点：

✓

> 伪代码

```ts
const h = ctx.audio(clip("bed"), { bus: "music" });
h.stop(300); // 回调内：300ms 淡出
```

✗ **在登记期 body 里读 `ctx`**

登记期只有 `env`（`SceneEnv`），`ctx` 是逐帧回调的参数。写 `env.audio(clip("x"), { at: ctx.t })` 在编译期就报错。

✓ 用 `at` 表达相对位置，或在 `step` 回调里用 `ctx.audio` 表达「此刻发射」。

## 边界与陷阱

- **`bgm` 的循环没有终点参数**：要定制循环区间用 `audio` + `loop(untilMs)`；`loop()` 省略 `untilMs` = 铺到时间线尾。
- **`synth` 的 `seed` 只影响 `noise`**：其余波形忽略种子，仍逐样本确定。`durationMs` 须 > 0，等于 0 或负数在渲染期报 `spec_violation`。
- **终点只有三处**：源播完、`stop()`、时间线尾。时间线尾是硬界，`stop` 给得再晚也不会让它越过时间线继续响。
- **`ctx.bus(id, spec?)` 只能在回调内调用**；给了 `spec` 只补登记不存在的总线（运行期懒建），重复声明不覆盖既有拓扑。
- **`rampMs ≤ 0` 立即生效**；过渡期内再次设值会从当前插值处重新起坡，不会跳变。
- **帧间隔决定过渡精度**：过渡按逐帧采样下发，斜坡终点最多晚一帧。
- **`pan` 超出 −1..1 会被夹**（运行期句柄），构造期组合子 `pan()` 则直接报错。
- **去重不是「只算一次」**：`ctx.once` 只挡重复的**事件**，帧照常求值、照常产帧。

## 相关

- 端口源码：`packages/contracts/src/scene/nodes.ts`（`AudioEnv` / `AudioGraphEnv` / `OnceEnv` / `OnceScope` / `AudioHandle` 的使用面）、`packages/contracts/src/audio/ports.ts`（`AudioOptions` / `AudioHandle` / `AudioClock` / `AudioOutput`）、`packages/contracts/src/audio/graph.ts`（`BusSpec` / `SendSpec` / `DuckRule` / `BusAutomationSpec` / `BusHandle`）、`packages/contracts/src/audio/synth.ts`（`SynthSpec`）；实现见 `packages/core/src/app/runtime/audio-runtime.ts`、`packages/core/src/app/runtime/audio-graph.ts`、`packages/core/src/domain/audio/combinators.ts`、`packages/infra/src/audio/offline-mixer.ts`。
- 示例：`examples/browser/ledger/audio.ts`（总线 + 发送 + 侧链 + `env.wait` 空档 + `env.synth`）。
- 相邻页：`first-clip.md`（单幕入口）、`compose-acts.md`（跨幕与并行链）、`export-mp4.md`（音频时钟与音轨写入顺序）、`debug-with-compute.md`（不整片验证声音程序）。
