# LingFan CodeVideo

> 视频不是文件，是一个跑 N 毫秒的自动游戏。

确定性视频引擎库：剧本 DSL 登记节点 → 双池时间线（总毫秒池 / 帧窗池）→ 确定性模拟 → 帧捕获 → 编码导出。
「游戏即视频」——同一份剧本，每次渲染得到逐帧相同的结果；LLM 是第一用户。

## 30 秒上手

```bash
pnpm install          # 安装（pnpm workspace，锁文件唯一事实来源）
pnpm typecheck        # 三包类型检查
pnpm test:unit        # 单元测试（tests/）
pnpm dev              # 浏览器实时预览：Vite dev server 打开 examples/browser
```

Node 侧最小示例（完整版见 `examples/three-acts.ts`）：

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const scene = start(1000, (env) => {
  env.step(1000, (ctx) => {
    const g = (ctx.canvas as HTMLCanvasElement).getContext("2d")!;
    g.fillRect(ctx.t / 4, 0, 40, 40); // 同一 t 必然同一画面
  });
});

await render(scene, {
  fps: 30,
  width: 640,
  height: 360,
  headless: true,
  exporter: new FrameSequenceExporter(),
});
```

## 仓库结构

```
packages/contracts   九域契约（零实现：类型 + 语义承诺注释）
packages/core        域层（compiler / validator / 时间层）+ 引擎 + 组合根（render / compute / validateScene）
packages/infra       契约的适配器实现（帧序列导出、WebCodecs MP4、离线混音、WebAudio 预览、内存捕获）
examples/            消费端示范（Node 脚本 + 浏览器实时预览），不是包
tests/               集中式单元/端到端测试，不是包
私有文档/             设计规约（唯一活文档：规约索引 → 各模块）
```

## 关键语义速览

- **双池时间**：语义层单位是毫秒；`fps` 只是采样密度。`cursor` 只被 `step`/`wait`/`par` 推进。
- **变帧率**：单元可声明 `fps`（三级继承：单元 > spawn 链 > `RenderOptions.fps`）；采样网格 = 各活跃单元自身网格点并集，空窗不产帧。
- **保活**：`forever` spawn 活到总链尾，链内容播完后循环重放；`kill`/`dispose` 即停。
- **所有函数可具名消杀，消亡也有过程**：spawn 链用 `key`/`Handle`，`step`/`loop` 用 `options.id`；`scheduler.kill(target, { fadeOut })` 或函数内部 `ctx.dispose({ fadeOut })` 触发——`fadeOut` 窗口内目标继续逐帧求值，回调拿 `disposing` / `disposeProgress` 0→1 自己画消失过程，窗口结束才真正出池（缺省立即死）。音频侧同义：`AudioHandle.stop(fadeOutMs)`。
- **音频是运行期的能力，不是一条音轨**：`ctx.audio(clip, opts)` 在任意 step/loop 回调里发声并拿到 `AudioHandle{stop, setGain, setRate}`——可共生（随状态收声）、可独美（自由发射）、可贯穿全局；引擎不因幕/段边界自动杀声音，唯一自动终界是总时间线尾。登记期用 `env.audio/env.bgm` 做声明。
- **事件与状态分开，去重显式**：`ctx.audio()` 每次执行都发（事件），引擎不替循环记轮次；要「每轮/每实例/整场只响一次」用 `ctx.once("iteration"|"spawn"|"scene"|"unit", fn)`——去重键确定性、每次 `run()` 重置。持续底噪用句柄持有 + `stop({ fadeOut })`，不走 `once`。
- **包络是数据，不是隐藏自动化**：`gain(v, { envelope: curve([[0,0],[200,1]]) })` / `ramp` / `fadeIn` / `fadeOut` 只是构造 `Envelope{points}`；`fromEnd` 拐点相对素材末尾定位（`fadeOut` 对任意时长成立）。导出与预览共用同一份拐点求值。
- **音频强类型**：`clip()` 是唯一音源构造入口（brand 类型）；音量/摆位/循环/变速是组合子（`gain/pan/loop/rate/warp`）并在构造期校验，非法组合立刻 `spec_violation`，不等到渲染才炸。
- **音频不占时间**：发声不推进时间池、不产帧；需要「只有声音的段落」用 `wait(ms)`。
- **静默段也能有运行期逻辑**：`wait(ms, onUpdate?)` 自身不产帧，但在「同帧有别的单元产帧」的网格点上逐帧回调（回调能力集只含声音/消杀/时间，不含 `step/loop/par/spawn`）；整段纯空窗时零回调是已知边界，要这段真有逻辑就用 `step`。运行期 `ctx.audio({ at })` 的 `at` 是**相对发射时刻的延迟**（「300ms 后响」），登记期 `env.audio({ at })` 才是相对登记位置——两条语义并存，不混用。
- **音频变速**：`warp` 分段线性时间映射——突然加速/恢复/不恢复、`srcMs:"end"` 自动填满区间、踩点；变速即变调（磁带式）。求值只有一处（`infra/audio/voice-timeline.ts`）：导出逐样本、预览转 AudioParam 自动化。
- **画什么就采什么**：视频的像素事实来源是绘制目标本身——step 回调画在 `ctx.canvas` 上，导出时引擎逐帧从该画布回读（`getImageData`）；GPU/离屏路径注入 `RenderOptions.painter`。不存在第二份像素来源，也不会静默交空白帧：两者都没有时缺省 `spec_violation`（首帧取像素时报），真要占位位图必须显式 `frames:"allow-blank"`。
- **导出 mp4 自带音轨**：`WebCodecsExporter` 用 H.264 + AAC-LC 编码并自封装 mp4，声音走 `OfflineAudioMixer`（与预览同一份合成公式/求值点）；组合根顺序是「帧 → 声 → finalize」，有声音却没音轨出口会直接 `spec_violation`，不静默丢声。浏览器示例点「导出 MP4」即可下载（`pnpm dev`）。
- **预览用音频时钟做主时钟**：`PacedPreviewExporter`（infra）按 `WebAudioOutput.nowMs()` 排帧——首次创建 AudioContext 时其时钟可能冷启动数秒，画面若跟墙钟就会「画面放完声音还在响」；无音频时钟或时钟停滞时自动退回墙钟，预览不会卡死。
- **终界只有一个**：总时间线结束即全停——末帧落在最后一个采样网格点、覆盖到终点后画面保留（之后无帧、无定时器），音频（含 `loop`）只在到终点的剩余时长内发声；导出端由缓冲长度裁齐，预览端显式排 `stop`。

## 文档

- 规约索引：[私有文档/CodeVideo规约/README.md](私有文档/CodeVideo规约/README.md)
- 开放问题与实现裁决：[11 号 RFC](私有文档/CodeVideo规约/11-rfc-open-issues.md)（§9 实现裁决表，含 §9.2 变帧率、§9.3 音频、§9.4 forever 循环、§9.5 音频变速、§9.6 预览装配、§9.7 生命周期终界、§9.8 音频模型、§9.9 重构验收、§9.10 视频帧来源、§9.11 导出音轨、§9.12 预览主时钟、§9.13 消杀与消亡过程、§9.14 帧来源缺失显式化、§9.15 `wait` 回调与运行期音频延迟、§9.16 `once` 事件去重与包络组合子）
- 契约设计规则：[13 号](私有文档/CodeVideo规约/13-contract-design.md)
- 目录规划：[14 号](私有文档/CodeVideo规约/14-directory-plan.md)
- B 阶段设计与裁决（游戏判据、wait 回调、事件去重、音频图 bus/sends/ducking）：[15 号](私有文档/CodeVideo规约/15-audio-graph-and-play-semantics.md)



