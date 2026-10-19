# 声音（AudioOptions / AudioHandle / Envelope / AudioRate / 总线图 / AudioClock / AudioOutput）

声音这一域的全部约定：一条声音在时间线上怎么登记、运行期怎么改、增益与包络怎么算、变速意味着什么、多路声音怎么汇到总线上，以及「离线混音」与「实时发声」两个端口各自管什么。端口在 `packages/contracts/src/audio/ports.ts`、`packages/contracts/src/audio/graph.ts`、`packages/contracts/src/audio/synth.ts`；实现分居 `packages/infra/src/audio/` 的两个类。

## 何时用 / 何时不用

- 用：要在一段剧本里加声音并控制它的起播位置，因为 `AudioOptions.at` 的基准随登记方式不同而有区别。
- 用：要在运行期淡出、改音量、改速度，因为 `AudioHandle` 的三个方法都按时间线毫秒记操作。
- 用：要让声音跟着画面一起变速变调，因为 `rate` / `warp` 的语义就是磁带式重采样。
- 用：要分组控音量、加效果、做侧链闪避，因为总线图是声明式数据，可整图复现。
- 用：出片要带音轨，因为 `AudioClock` 把声音程序渲染成样本块交给导出器。
- 不用：只想在浏览器里试听，改用 `AudioOutput`，见 `docs/guides/add-audio.md`。
- 不用：只想让声音在某个单元里响一次，改用 `ctx.once`，见 `docs/contracts/scene.md`。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 登记期声音的时间锚点换算成全局绝对时间后进入程序 | 程序中 `startMs` 等于段落起点加登记处偏移 | `tests/audio.test.ts` |
| 运行期 `ctx.audio` 的 `at` 相对发射时刻，而非登记位置 | 100 毫秒处发射、`at` 200 → 起播 300 毫秒 | `tests/audio-emit-delay.test.ts` |
| 登记期 `at` 仍相对登记位置；负 `at` 按 0 钳 | 起播不早于段落起点 | `tests/audio-emit-delay.test.ts` |
| 最后一个 `step` 里触发的声音不会被丢 | 程序里仍有该声音 | `tests/audio.test.ts` |
| 句柄操作写进操作记录，时刻等于求值时刻；回调外操作句柄 → `spec_violation` | 操作记录时刻与 `ctx.t` 相等 | `tests/audio.test.ts` |
| 单声道源铺到立体声输出时复制到两路 | 两声道样本相等 | `tests/audio.test.ts` |
| 多个实例落在同一时刻时样本相加 | 叠加后幅度等于各自之和 | `tests/audio.test.ts` |
| `loop` 按源时长回卷铺满窗口 | 100 毫秒源铺 250 毫秒窗口 = 1.5 圈 | `tests/audio.test.ts` |
| `fadeIn` 从 0 线性升到基础值、`fadeOut` 贴源实际终点倒算 | 起点样本为 0、终点归零 | `tests/envelope.test.ts` |
| `ramp` 在 `[0, ms]` 内线性、之后保持；包络与基础增益相乘 | 折点值与 `gainAt` 一致 | `tests/envelope.test.ts` |
| `pan = -1` 全留左声道、`pan = 0.5` 右声道衰减 | 线性律：`pan = -1` → 左 1 / 右 0；`pan = 0.5` → 左 0.5 / 右 1 | `tests/audio.test.ts` |
| `rate(2)` 使源播完时长减半；`warp` 分段变速后恢复原速 | 2 倍速输出帧取源位置 2i；`srcMs:"end"` 填满事件区间 | `tests/audio-warp-render.test.ts` |
| 速率透传进声音记录不预解析，非法字面量在校验期被兜底 | 校验报 `spec_violation` | `tests/audio-warp-engine.test.ts` |
| 总线上叠加增益、发送、侧链都按声明生效 | 目标总线在触发时被压低、释放后恢复 | `tests/audio-graph.test.ts` |
| 逐帧总线参数在相邻帧之间线性插值；过渡未结束时再改从当前插值处重新起坡 | 参数轨迹连续 | `tests/audio-graph.test.ts` |
| 未登记的总线回落 `master`；父链成环 → `spec_violation` | 环路在校验期报错 | `tests/audio-graph.test.ts` |
| 预览实时发声与离线混音逐样本一致 | 两条路产出同一串样本 | `tests/audio-parity.test.ts` |
| 同一份合成 spec 两次渲染逐样本相同；噪声只受 seed 影响 | 非噪声波形忽略 seed | `tests/audio-synth-effects.test.ts` |
| 分贝记法在折算处一次性落成线性幅度，与等值线性写法产出同一份样本 | 两条路样本逐字节相等 | `tests/gain-units.test.ts` |

## 用法

登记一条声音并让它跟着段落的节奏淡入：

```ts
import { start, clip, gain, pan } from "@lingfan-video/core";

const scene = start(2000, (env) => {
  env.audio(clip("todo://bgm.wav"), {
    at: 500, // 相对登记位置：段落起点后 500 毫秒起播
    gain: gain({ db: -6 }, { fadeIn: 800 }), // fadeIn 的单位是毫秒
    pan: pan(-0.2),
  });
  env.step(2000, () => {});
});
```

运行期控制句柄——所有方法都以当前回调时刻为生效时刻：

```ts
import { start, clip, gain } from "@lingfan-video/core";
import type { AudioHandle } from "@lingfan-video/contracts";

let voice: AudioHandle | undefined;

const scene = start(2000, (env) => {
  env.step(2000, (ctx) => {
    voice ??= ctx.audio(clip("todo://line.wav"), { gain: gain(0.8) });
    if (ctx.t >= 1000) voice.setGain(0.3, 200); // 200 毫秒内线性过渡到 0.3
    if (ctx.t >= 1800) voice.stop(200); // 200 毫秒淡出后停
  });
});
```

变速与包络：`rate` 是磁带式重采样，变速即变调；`envelope` 是增益的时间函数，末点用 `fromEnd` 就能在没有源真实时长的情况下做收尾淡出。

```ts
import { start, clip, curve, fadeOut, gain, warp } from "@lingfan-video/core";

const scene = start(3000, (env) => {
  env.audio(clip("todo://riser.wav"), {
    rate: warp([0, 0], [2000, 4000]), // 锚点是 [时间线毫秒, 源毫秒]；2000 毫秒处已推进到源 4000 毫秒 = 2 倍速
    gain: gain(1, { envelope: curve([0, 0], [2000, 1]) }), // 折点是 [局部毫秒, 线性倍率]
  });
  env.audio(clip("todo://tail.wav"), {
    gain: gain(1, { envelope: fadeOut(300) }), // 收尾淡出贴声音实际终点，不需要预先知道源时长
  });
  env.step(3000, () => {});
});
```

总线图与侧链：`master` 隐式存在不需要登记，其余总线声明 `parent`、效果与增益。

```ts
import { start } from "@lingfan-video/core";

const scene = start(2000, (env) => {
  env.bus({ id: "music", gain: 0.6, effects: [{ kind: "filter", type: "highpass", frequency: 200 }] });
  env.bus({ id: "voice", parent: "master", gain: 1 });
  env.send({ from: "voice", to: "music", amount: 0.15 }); // 缺省 post-fader
  env.duck({ from: "voice", to: "music", amountDb: 8 }); // 人声出现时压低音乐
  env.step(2000, () => {});
});
```

渲染声音程序成样本块（导出端）：

```ts
import { compileAudioProgram } from "@lingfan-video/core";
import { OfflineAudioMixer } from "@lingfan-video/infra";

// 解码器把 clip 解成 PCM；合成音源不经过它，这里只放一个明确的桩
const decoder = {
  async decode() {
    throw new Error("本段只用合成音源，不解码素材");
  },
};

const clock = new OfflineAudioMixer(decoder, { sampleRate: 48_000, channels: 2 });
const program = await compileAudioProgram(scene, { fps: 30, width: 320, height: 180 });
const blocks = await clock.renderProgram(program); // 块序列自 0 起连续
void blocks; // 每块 data 是交错 Float32 PCM，长度 = 该块帧数 × channels
```

## 反例

- ✗ 写法：`rate: -1` 想做倒放 —— 为什么错：速率须恒正，语义是磁带式重采样（斜率 = 速率 = 音高倍率），不支持倒放与静止；✓ 改成：把源本身反向预处理后再以正速率使用。
- ✗ 写法：`rate: 2` 同时期望音高不变 —— 为什么错：变速即变调，重采样改变的是每秒取多少个源样本，音高与时长一起变；✓ 改成：接受变调，或改用别的素材。
- ✗ 写法：在 `step` 回调之外保存 `AudioHandle` 并定时调 `setGain` —— 为什么错：所有操作以当前回调时间为生效时刻，回调外调用报 `spec_violation`，因为没有可信的时间线时刻；✓ 改成：在逐帧回调里按 `ctx.t` 触发。
- ✗ 写法：`fadeOut(300)` 的同时给 `loop()` 铺到时间线尾，期望在源播完处淡出 —— 为什么错：`fromEnd` 的「末」指该声音在时间线上实际结束的位置；循环把终点推到 `untilMs` 或时间线尾，淡出因此在那个位置开始；✓ 改成：需要按源时长收尾就别循环，或显式给 `untilMs`。
- ✗ 写法：用 `AudioOutput` 代替 `AudioClock` 出片 —— 为什么错：实时发声允许非确定（延迟由平台时钟决定），导出端要的是「样本 = 时间线纯函数」；✓ 改成：出片注入 `AudioClock`，预览才用 `AudioOutput`。
- ✗ 写法：`env.bus({ id: "a", parent: "b" })` 与 `env.bus({ id: "b", parent: "a" })` 互指 —— 为什么错：父链、发送、侧链成环都在装配时报 `spec_violation`；✓ 改成：让父链收敛到 `master`。

## 边界与陷阱

- `AudioOptions.at`：登记期（`env.audio` / `env.bgm`）相对登记位置，单位毫秒；运行期（`ctx.audio`）相对发射时刻的延迟，负值按 0 钳。缺省 = 0。
- `AudioOptions.gain`：线性幅度或 `{ db }` 记法，缺省 1。两种写法是同一个量的两种记法，换算只有一处实现，平台侧永远收到线性幅度。
- `AudioOptions.pan`：-1..1，缺省 0（居中）；非立体声输出恒居中。
- `AudioOptions.loop`：缺省不循环，源播完即止；`loop(untilMs)` 的终界是时间线毫秒，不是无限。
- `AudioOptions.rate`：缺省原速。`{ kind: "rate", value }` 恒速，`{ kind: "warp", points }` 分段变速；`WarpPoint.atMs` 严格递增，`srcMs` 可为 `"end"`（只允许末位）。速率恒正，不支持倒放。
- `AudioOptions.bus`：缺省 `master`。`master` 是隐式顶层母线，不需要登记。
- `fadeIn` / `fadeOut` 的单位是时间线毫秒（不随变速伸缩）；`envelope` 的 `value` 是线性倍率，与基础增益相乘。
- `EnvelopePoint.atMs`：相对该声音起点；`fromEnd: true` 时从声音终点倒量——源真实时长未知也成立，用于收尾淡出。
- `Envelope` 取值规则：首点之前取首值，末点之后取末值；折点必须按 `atMs` 严格递增，空表与负值在构造期报 `spec_violation`。
- `AudioHandle.startedAtMs`：该声音在时间线上的起播时刻（毫秒）。`alive` 在 `stop()` 之后或源播完即为假。
- `AudioHandle.setGain(value, rampMs)` / `setRate(value, rampMs)`：`rampMs` 从当前有效值起线性过渡，单位毫秒；缺省立即生效。
- 句柄操作记录成 `AudioOp`（`stop` / `gain` / `rate` 三种，`atMs` 为全局时间线毫秒）；操作落在声音结束之后不报错，按无效果处理。
- 生命周期：源自然播完、`stop()`、总时间线尾，三者之一是终点。引擎不因为幕、段、链的边界自动杀声音。
- 可闻区间左闭右开：`[startMs, endMs)`。终点那一帧不算在响，起点那一帧算。
- 组合子的参数形态：`curve` / `warp` 的折点与锚点是元组 `[毫秒, 值]`，不是对象；写错形态在构造期报 `spec_violation`。
- 总线的 `BusSpec.parent`：缺省 `master`。父名未登记或指向自己时退回 `master`；父链、发送、侧链成环在装配时报 `spec_violation`。
- `BusSpec.effects`：按数组顺序作用于该总线的输入，然后才过 `gain` / `pan` 与侧链。
- `FilterSpec.q` 缺省 0.707，`bandpass` 建议 0.5..8；`CompressorSpec.kneeDb` 缺省 0（硬拐点），正值在阈值上下各半个拐点宽度内按二次曲线折算；`DelaySpec.feedback` 缺省 0.3（范围 0..0.95），`mix` 缺省 0.5；`ReverbSpec.roomSize` 缺省 0.7、`damping` 缺省 0.4、`mix` 缺省 0.35。
- `SendSpec.pre`：缺省 false（post-fader）；`amount` 取 0..1。
- `DuckRule.amountDb` 是正数（压低多少分贝）；`attackMs` 缺省 10、`holdMs` 缺省 0、`releaseMs` 缺省 200、`thresholdDb` 缺省 -30。
- `BusAutomation` 的 `points` 按 `atMs` 递增；`BusAutomationSpec.points` 为空 = 无计划。`AutomationPoint.atMs` 相对声明段落起点，同一段被重复播放时自动同相位平移；`rampMs` 缺省立即。
- `BusHandle` 的参数按帧采样（帧间混音端线性插值），`rampMs ≤ 0` 立即生效，斜坡终点最多晚一帧对齐到采样点。`alive` 在消亡窗口内仍为真。
- `AudioClock`（离线混音，导出端）：`sampleRate` 由导出格式决定，`channels` 同；`renderProgram` 返回的块序列自 0 起、按时间顺序连续、无空隙，接收端按顺序拼接即整轨。样本 = 时间线纯函数：同程序必同样本，输出只依赖程序与该实现声明的采样率/声道数，与视频帧率无关。
- `AudioOutput`（实时发声，预览端）：`begin` 锚定时间线起点并预排登记期声音（总线拓扑在此时建立）；`start(voice)` 立即开始或在该声音 `startMs` 到点时开始；`setBus` 可缺省，缺省 = 预览忽略逐帧总线参数；`dispose` 重复调用安全。允许非确定。导出端不用这个端口。
- `SynthSpec.envelope` 缺省 5 毫秒起音 / 30 毫秒衰减 / 0.8 保持 / 80 毫秒释放；`gain` 缺省 0.4（合成时乘一次，最终电平 = 声音自身增益 × 时间线 voice 增益）；`seed` 缺省 12345 且只影响 `noise`；`detune` 音分缺省 0；`durationMs` 须大于 0。
- 确定性前提：同一程序、同一实现、同一采样率与声道数 → 逐样本相同；跨实现的浮点路径差异要按样本容差判。

## 相关

- 端口源码：`packages/contracts/src/audio/ports.ts`、`packages/contracts/src/audio/graph.ts`、`packages/contracts/src/audio/synth.ts`、`packages/contracts/src/audio/gain.ts`
- 实现：`packages/infra/src/audio/offline-mixer.ts`（`AudioClock`）、`packages/infra/src/audio/web-audio-player/index.ts`（`AudioOutput`）
- 相邻页：`docs/contracts/export.md`、`docs/contracts/scheduler.md`、`docs/contracts/scene.md`、`docs/contracts/index.md`
