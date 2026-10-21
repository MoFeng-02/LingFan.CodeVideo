# LingFan CodeVideo

> 视频不是文件，是一个跑 N 毫秒的自动游戏。

确定性推演式视频引擎：剧本 DSL 登记节点 → 双池时间线（总毫秒池 / 帧窗池）→ 确定性模拟 → 帧捕获 → 音频铺轨 → 导出。
同一份剧本，每次推演逐帧相同。**总时长是编译产物，不是设计参数**；LLM 是第一用户，所以 API 对歧义是零容忍的。

## 30 秒上手

```bash
pnpm install          # 安装（pnpm workspace，锁文件唯一事实来源）
pnpm typecheck        # 三包类型检查
pnpm test:unit        # 单元测试（tests/）
pnpm dev              # 浏览器实时预览：Vite dev server 打开 examples/browser
```

Node 侧最小示例（完整版见 `examples/three-acts/main.ts`，浏览器版见 `examples/minimal/main.ts`）：

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

// 登记期：只声明节点与窗口，不执行任何画面
const scene = start(1000, (env) => {
  env.step(1000, (ctx) => ({ t: ctx.localT })); // 返回值 = 本幕 body，传给下一幕
});

// 推演期：按注册顺序逐帧求值并交出帧
const { frames, durationMs } = await render(scene, {
  fps: 30,
  width: 640,
  height: 360,
  headless: true,
  frames: "allow-blank", // 未注入 painter 时显式接受占位位图（真实像素路径见下）
  exporter: new FrameSequenceExporter(),
});
```

帧像素的唯一来源是绘制目标本身：注入 `painter` 由宿主自绘，或给一个能 `getContext("2d")` 的 `canvas` 走回读。两者都没有时 `render` 直接报 `spec_violation`，不会静默交出空白帧——`frames: "allow-blank"` 只是显式确认「本次不需要真实像素」。细节见 [`docs/contracts/capture.md`](docs/contracts/capture.md)。

## 文档

| 想知道什么                                                  | 读哪里                                         |
| ----------------------------------------------------------- | ---------------------------------------------- |
| 这东西到底是什么、怎么运作                                  | [`docs/mental-model.md`](docs/mental-model.md) |
| 按当前任务找页面                                            | [`docs/README.md`](docs/README.md)             |
| 写剧本 / 拼多幕 / 加声音 / 出 mp4 / 出透明产物 / 不整片验证 | [`docs/guides/`](docs/guides/first-clip.md)    |
| 某个类型或端口的语义承诺                                    | [`docs/contracts/`](docs/contracts/index.md)   |
| 代码没报错但「不太对」                                      | [`docs/pitfalls.md`](docs/pitfalls.md)         |
| 术语的准确含义                                              | [`docs/glossary.md`](docs/glossary.md)         |

给 AI 编码工具的入口是 [`.agents/skills/codevideo/SKILL.md`](.agents/skills/codevideo/SKILL.md)：它只做路由，按任务分发到 `codevideo-scene` / `codevideo-schedule` / `codevideo-audio` / `codevideo-export` / `codevideo-verify` 五个模块 skill；每个模块 skill 自包含地给出 API 用法、组合方式与验证判据，不依赖 `docs/`。

## 仓库结构

```
packages/contracts   契约层（零实现依赖：类型 + 语义承诺）
packages/core        纯域层（编译 / 校验 / 时间数学）+ 引擎运行时 + 组合根
packages/infra       契约的默认适配器（帧序列、透明动图、WebCodecs mp4、离线混音、WebAudio 预览、诊断）
examples/            消费端示范（Node 脚本 + 浏览器实时预览），不是包
tests/               集中式单元 / 端到端测试，不是包
docs/                公开文档（判据式：断言、反例、钉子）
.agents/skills/      给 AI 编码工具的模块化 skill
```

## 关键语义速览

- **双池时间**：语义层单位是毫秒；`fps` 只是采样密度。`cursor` 只被 `step`/`wait`/`par` 推进。
- **变帧率**：单元可声明 `fps`（三级继承：单元 > spawn 链 > `RenderOptions.fps`）；采样网格 = 各活跃单元自身网格点并集，空窗不产帧。
- **保活**：`forever` spawn 活到总链尾，链内容播完后循环重放；`kill`/`dispose` 即停。
- **所有函数可具名消杀，消亡也有过程**：spawn 链用 `key`/`Handle`，`step`/`loop` 用 `options.id`；`scheduler.kill(target, { fadeOut })` 或函数内部 `ctx.dispose({ fadeOut })` 触发——`fadeOut` 窗口内目标继续逐帧求值，回调拿 `disposing` / `disposeProgress` 0→1 自己画消失过程，窗口结束才真正出池（缺省立即死）。音频侧同义：`AudioHandle.stop(fadeOutMs)`。
- **音频是运行期的能力，不是一条音轨**：`ctx.audio(clip, opts)` 在任意 step/loop 回调里发声并拿到 `AudioHandle{stop, setGain, setRate}`——可共生（随状态收声）、可独美（自由发射）、可贯穿全局；引擎不因幕/段边界自动杀声音，唯一自动终界是总时间线尾。登记期用 `env.audio/env.bgm` 做声明。
- **声音有图可路由，导出可复算**：`env.bus/send/duck` 登记期定拓扑，运行期 `ctx.bus(id).gain(...)` / `kill({fadeOut})` 只改参数与生命周期；导出端逐样本过「总线 → 效果 → 侧链 duck → master」，预览端按图建 WebAudio 节点（duck 与插值不还原，以导出端结果为准）。`AudioProgram.graph` 缺省时走平铺混音路径。
- **参数轨迹可以写成数据**：`env.automate({ bus:"music", points:[{ atMs:0, gain:0.2 }, { atMs:400, gain:1, rampMs:200 }] })` 登记一条到点生效的计划（时刻相对声明段起点，循环圈同相位重放）；它与运行期 `ctx.bus` 共用同一个参数面，先声明后微调不打架。
- **事件与状态分开，去重显式**：`ctx.audio()` 每次执行都发（事件），引擎不替循环记轮次；要「每轮/每实例/整场只响一次」用 `ctx.once("iteration"|"spawn"|"scene"|"unit", fn)`——去重键确定性、每次 `run()` 重置。持续底噪用句柄持有 + `stop({ fadeOut })`，不走 `once`。
- **包络是数据，不是隐藏自动化**：`gain(v, { envelope: curve([[0,0],[200,1]]) })` / `ramp` / `fadeIn` / `fadeOut` 只是构造 `Envelope{points}`；`fromEnd` 拐点相对素材末尾定位（`fadeOut` 对任意时长成立）。导出与预览共用同一份拐点求值。
- **音频强类型**：`clip()` 是唯一音源构造入口（brand 类型）；音量/摆位/循环/变速是组合子（`gain/pan/loop/rate/warp`）并在构造期校验，非法组合立刻 `spec_violation`，不等到渲染才炸。
- **音频不占时间**：发声不推进时间池、不产帧；需要「只有声音的段落」用 `wait(ms)`。
- **静默段也能有运行期逻辑**：`wait(ms, onUpdate?)` 自身不产帧，但在「同帧有别的单元产帧」的网格点上逐帧回调（回调能力集只含声音/消杀/时间，不含 `step/loop/par/spawn`）；整段纯空窗时零回调（wait 不产帧就没有网格点），要这段真有逻辑就用 `step`。运行期 `ctx.audio({ at })` 的 `at` 是**相对发射时刻的延迟**（「300ms 后响」），登记期 `env.audio({ at })` 才是相对登记位置——两条语义并存，不混用。
- **音频变速**：`warp` 分段线性时间映射——突然加速/恢复/不恢复、`srcMs:"end"` 自动填满区间、踩点；变速即变调（磁带式）。求值只有一处（`infra/audio/voice-timeline.ts`）：导出逐样本、预览转 AudioParam 自动化。
- **程序化音源也是声音**：`env.synth({ wave:"triangle", freq:660, durationMs:700 })`（登记期）与 `ctx.synth(...)`（运行期）产出与 `audio` 同形态的声音（增益/包络/pan/句柄/时间线终界全沿用）；振荡器相位从 0 起算、噪声是 xorshift32，同一份 spec 每次导出逐样本相同。合成声源时值已知，`fadeOut`/`fromEnd` 包络因此能落点。音量写在 `synth.gain`（合成时乘一次），时间线侧另有 voice 增益（缺省 1，`setGain`/`kill` 在其上叠乘）——两者相乘得到最终电平，同一个数字不会被应用两次。
- **噪声可复现**：`synth` 的 `seed` 只作用于 `noise` 波形（其余波形忽略），不声明则用固定缺省种子——同 seed + 同采样率得到逐样本相同的噪声，预览与导出取的是同一套伪随机序列，所以「每次导出都一样」对噪声同样成立。
- **效果是总线的一部分**：`env.bus({ id:"echo", effects:[{ kind:"delay", delayMs:180, feedback:0.35, mix:0.5 }] })` 声明一次，之后 `ctx.audio(clip, { bus:"echo" })` 或 `ctx.synth(..., { bus:"echo" })` 就挂上去；`filter`/`compressor`/`delay`/`reverb` 按声明顺序就地作用，导出端自研 DSP（确定性、可复算），预览端用 WebAudio 节点（音色近似、时序一致）。
- **画什么就采什么**：视频的像素事实来源是绘制目标本身——step 回调画在 `ctx.canvas` 上，导出时引擎逐帧从该画布回读（`getImageData`）；GPU/离屏路径注入 `RenderOptions.painter`。不存在第二份像素来源，也不会静默交空白帧：两者都没有时缺省 `spec_violation`（首帧取像素时报），真要占位位图必须显式 `frames:"allow-blank"`。
- **导出 mp4 自带音轨**：`WebCodecsExporter` 用 H.264 + AAC-LC 编码并自封装 mp4，声音走 `OfflineAudioMixer`（与预览同一份合成公式/求值点）；组合根顺序是「帧 → 声 → finalize」，有声音却没音轨出口会直接 `spec_violation`，不静默丢声。浏览器示例点「导出 MP4」即可下载（`pnpm dev`）。
- **透明产物是声明，不是开关**：`RenderOptions.alpha: "alpha"` 声明这一趟要交出带 alpha 的画布，随 `FrameHostInfo.alpha` 交给帧宿主、落到合成器建场——两档只差「干净」是哪种干净（不透明黑 / 全透明），共同不变量仍是「每帧从干净画布开始，输出与上一帧无关」。产物能否带 alpha 由封装与实例声明共同决定：`ApngExporter` 逐帧保 alpha 出单文件动图、`WebmExporter({ alpha: true })` 出带音轨的透明 webm（VP8/VP9 颜色轨 + 一条只含关键帧的 alpha 侧通道）、`FrameSequenceExporter` 留原始 RGBA；声明透明却配 mp4 会在首帧前 `spec_violation`，不静默填黑。设备句柄要位图用 `createReadbackHost` 包一层——回读在帧来源侧，不在导出器里。浏览器示例点「导出透明 APNG」/「导出透明 WebM」各下载一份（`pnpm dev`），两条路只换导出器与封装声明，其余与 mp4 那条完全共用。
- **webm 与 mp4 是两条编码路径**：`WebmExporter` 用 VP8/VP9 + Opus 自封装 webm，容器自己写（EBML 分段、簇、索引），透明档多开一路 alpha 编码器并落在 `BlockAdditions`；文件探针看到的仍是普通 yuv 像素格式，alpha 在侧通道里。Opus 采样率固定 48kHz，不静默重采样。
- **预览用音频时钟做主时钟**：`PacedPreviewExporter`（infra）按 `WebAudioOutput.nowMs()` 排帧——首次创建 AudioContext 时其时钟可能冷启动数秒，画面若跟墙钟就会「画面放完声音还在响」；无音频时钟或时钟停滞时自动退回墙钟，预览不会卡死。
- **终界只有一个**：总时间线结束即全停——末帧落在最后一个采样网格点、覆盖到终点后画面保留（之后无帧、无定时器），音频（含 `loop`）只在到终点的剩余时长内发声；导出端由缓冲长度裁齐，预览端显式排 `stop`。

## 门禁与提交

```bash
pnpm lint        # typecheck + format:check + eslint（唯一门禁口径）
pnpm test:unit   # vitest run
```

`docs/**/*.md` 与 `.agents/**/*.md` 不在 prettier 格式化范围内。
