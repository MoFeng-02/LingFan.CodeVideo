---
name: codevideo-audio
description: 声音的登记与运行期控制：clip/gain/pan/loop/rate/warp/curve/fadeIn/fadeOut 组合子、包络与 fromEnd、总线路由图与侧链 duck、AudioHandle 的 stop/setGain/setRate、ctx.once 的四种去重作用域。Use when adding sound, routing buses, writing automation, or deciding when a sound should stop.
metadata:
  version: "2.0.0"
---

# 声音：登记、组合与运行期控制

登记期（`env.audio` / `env.bgm` / `env.synth` / `env.bus` / `env.send` / `env.duck` / `env.automate`）与运行期（`ctx.audio` / `ctx.synth` / `ctx.bus`）最终走**同一编译路径**。项目思维：声音是运行期的能力，不是一条音轨——它在任意回调里发声、可共生可独美，引擎不因幕/段边界自动杀声，唯一自动终界是总时间线尾；同时**音频不占时间**：发声不推进时间池、不产帧。

## 何时用 / 何时不用

- 用：加声音、路由总线、侧链压低、写参数轨迹、变速变调、决定声音何时收。
- 不用：写画面或状态 → `codevideo-scene`；出片与预览装配 → `codevideo-export`。

## API 面备查（签名以源码为准）

| 你要 | API | 要点 |
| --- | --- | --- |
| 音源 | `clip(url: string): AudioClip` | 唯一音源构造入口；brand 强类型，裸字符串不通用 |
| 音量 | `gain(value, { fadeIn?, fadeOut?, envelope? })` | `value` 线性或 `{ db }`；fade 在时间线毫秒域，不随变速伸缩 |
| 摆位 | `pan(value: number): AudioPan` | -1..1，构造期校验 |
| 循环 | `loop(untilMs?: Ms): AudioLoop` | 省略 = 铺到总时间线尾 |
| 恒速变速 | `rate(value: number): AudioRate` | `> 0`，**变速即变调**（磁带式重采样），不支持倒放 |
| 变速映射 | `warp([[atMs, srcMs], ...])` | 锚点 `atMs` 严格递增、`srcMs` 递增；`srcMs:"end"` 必须是末个锚点 = 拉伸到填满声音区间；线性插值斜率即速率即音高倍率 |
| 包络 | `curve([[atMs, value], ...])` | 分段线性乘子；折点纯数据，`atMs` 严格递增，首点前取首值末点后取末值，与基础增益相乘 |
| 淡入淡出 | `fadeIn(ms)` / `fadeOut(ms)` / `ramp(from, to, ms)` | `fadeOut` 基于 `fromEnd` 拐点，对任意时长素材成立 |
| 登记声音 | `env.audio(clip, options?)` / `env.bgm(clip, options?)` | `bgm` = `Omit<AudioOptions,"loop">`，铺到尾；`options.at` = **相对登记位置** |
| 登记程序化音源 | `env.synth({ wave, freq, durationMs, ... })` | 与 `audio` 同形态；相位从 0 起算，噪声用 `seed`（xorshift32，可复现） |
| 总线 | `env.bus({ id, parent?, gain?, pan?, mute?, solo?, effects? })` | 顶层母线恒 `master`；同 id 重复登记以最后一处为准 |
| 发送/侧链 | `env.send({ from, to, amount, pre? })` / `env.duck({ from, to, amountDb, attackMs?, holdMs?, releaseMs?, thresholdDb? })` | duck = from 响时压低 to |
| 参数轨迹 | `env.automate({ bus, points: [{ atMs, gain?, pan?, rampMs? }] })` | 时刻相对声明段起点，循环圈同相位重放；与运行期 `ctx.bus` 共用同一参数面 |
| 运行期发声 | `ctx.audio(clip, options?)` | 返回 `AudioHandle`；`options.at` = **相对发射时刻**的延迟（负值按 0） |
| 运行期句柄 | `handle.stop(fadeOutMs?)` / `handle.setGain(value, rampMs?)` / `handle.setRate(value, rampMs?)` | 只能在回调内调用，回调外报 `spec_violation` |
| 运行期总线 | `ctx.bus(id).gain(...)` 等 | 只改参数与生命周期，不改拓扑 |
| 一次性事件 | `ctx.once(scope?, fn)` | 四作用域：`"unit"`（含 loop 全部迭代，缺省）/ `"iteration"`（每轮）/ `"spawn"`（每实例）/ `"scene"`（整场）；`OnceContext` 只有 `audio` + `dispose`，去重键确定性、每次 run 重置 |

## 硬约束

1. **音频不占时间线**：发声不推进游标、不产帧、不消耗帧窗池；需要「只有声音的段落」用 `wait(ms)`。
2. **引擎不因幕段边界杀声**：声音寿命 = 源播完 / `stop` / 总时间线尾，三者取先。
3. **`at` 双语义并存**：登记期相对登记位置、运行期相对发射时刻——写之前先想清自己在哪个期。
4. **变速即变调**：`rate`/`warp` 的斜率同时是播放速率与音高倍率，速率恒正、无倒放。
5. **包络是纯数据**：`Envelope{points}` 拐点严格递增；`fromEnd` 相对素材末尾定位；导出与预览共用同一份拐点求值。
6. **句柄只在回调内**：`AudioHandle` 的方法在回调外调用报 `spec_violation`。
7. **`clip()` 是强类型音源**：URL 直接传给 `audio()` 会丢 brand；组合子在构造期校验，非法组合立刻 `spec_violation`，不等到渲染。
8. **母线恒 master 顶层**：总线图是树，`parent` 指向已有总线；效果按声明顺序就地作用。

## 骨架

```ts
import { start, clip, gain, pan, loop, fadeIn, fadeOut } from "@lingfan-video/core";

const scene = start(8000, (env) => {
  // 登记期：拓扑一次定型
  env.bus({ id: "music", gain: 0.9 });
  env.bus({ id: "sfx", parent: "master" });
  env.send({ from: "sfx", to: "master", amount: 0.2 });
  env.duck({ from: "sfx", to: "music", amountDb: -6, attackMs: 20, releaseMs: 200 });

  // 登记期：铺底音乐，淡入淡出写在时间线毫秒域
  env.bgm(clip("theme.mp3"), {
    gain: gain(0.6, { fadeIn: fadeIn(500), fadeOut: fadeOut(800) }),
    loop: loop(),                       // 省略 untilMs = 铺到总时间线尾
  });

  env.step(4000, (ctx) => {
    // 运行期：命中音效，每次执行都发（事件）
    ctx.once("scene", () => {           // 整场只响一次
      ctx.audio(clip("hit.wav"), {
        at: 0,                          // 运行期 at：相对发射时刻
        gain: gain(1, { envelope: fadeOut(150) }),
        pan: pan(-0.4),
        bus: "sfx",
      });
    });
    // 拿到句柄做运行期控制
    const h = ctx.audio(clip("whoosh.wav"), { bus: "sfx" });
    h.setRate(1.2, 100);                // 100ms 内平滑升到 1.2 倍（变调跟随）
  });
});
```

## 验证判据

```bash
pnpm vitest run tests/audio.test.ts tests/audio-graph.test.ts tests/once.test.ts tests/envelope.test.ts tests/audio-parity.test.ts tests/audio-warp-engine.test.ts
```

- 拓扑：`compileAudioProgram` 产出的 `AudioProgram.graph` 与手画的总线树一致。
- 双端同源：`audio-parity` 证明导出端逐样本与预览端同一套求值点。
- 变速：`warp` 锚点斜率 = 采样区间速率，导出端只有 `infra/audio/voice-timeline.ts` 一处求值。

## 常见错法

| ✗ 错法 | 为什么错 | ✓ 改成 |
| --- | --- | --- |
| 用 `wait` 让声音「播 800ms」 | wait 只占时间不发声；音频不占时间 | `ctx.audio(clip, { at })` 或登记期 `env.audio` |
| 幕结束时手动 `handle.stop()` 收声 | 引擎不因边界杀声；手动补刀让因果散落 | 交给寿命规则；确要早停才 `stop(fadeOutMs)` |
| 登记期写 `at: 300` 以为「300ms 后响」 | 登记期 `at` 相对登记位置，不是延迟 | 运行期 `ctx.audio(clip, { at: 300 })` 才是「发射后 300ms」 |
| `rate(-1)` 想倒放 | 速率恒正，变速即变调、无倒放 | 重新编排剧本顺序 |
| `gain("6dB")` 传字符串 | 组合子强类型：线性数字或 `{ db: 6 }` | `gain({ db: 6 })` 或按线性值换算 |
| `warp` 锚点 `atMs` 乱序 | 锚点必须严格递增，否则构造期报错 | 排序后再传 |
| 循环体里直接 `ctx.audio` 不去重 | 每轮迭代都发一次（事件语义） | `ctx.once("iteration", ...)` 或 `"spawn"` / `"scene"` |
| 把总线当全局单例改 | 能力即上下文：没有 `ctx`/`env` 就调不到 | 在回调内经 `ctx.bus(id)` 改参数 |

## 边界与陷阱

- **`bgm` = `Omit<AudioOptions,"loop">`**，缺省铺到总时间线尾；要限长用 `env.audio` + `loop(untilMs)`。
- **`loop(untilMs?)` 省略参数 = 铺到总时间线尾**，不是素材播完即止。
- **`gain` 线性或 `{ db }`；`pan` 限 -1..1**——越界构造期抛 `spec_violation`。
- **`warp` 的 `srcMs:"end"` 必须是最后一个锚点**：含义是「从这里拉伸到素材尾、填满剩余声音区间」。
- **导出端 `AudioClock`（离线逐样本）与预览端 `AudioOutput`（实时 WebAudio）是两条端口**：预览允许非确定，导出必须确定；有声音却没有音轨出口时导出报 `spec_violation`，不静默丢声。
- **效果链在总线上声明一次**：`env.bus({ id:"echo", effects:[{ kind:"delay", delayMs:180, feedback:0.35, mix:0.5 }] })`，之后任何挂到该总线的声音都过效果；导出端自研 DSP，预览端用 WebAudio 节点近似（音色近似、时序一致）。
