---
name: codevideo
description: 本仓（LingFan CodeVideo 确定性视频引擎）的唯一入口。只要任务涉及用这套契约写剧本、改时间线/幕间过渡、加音频、接导出或预览、验证确定性，就先加载本 skill 路由到对应的一个模块 skill。它只做分发，不直接给做法。Use before writing any scene, timeline, audio, export, or preview code against this library.
metadata:
  version: "2.0.0"
---

# CodeVideo 路由根

本仓把视频当**一段跑 N 毫秒的确定性程序**：剧本登记节点 → 编译成双池时间线 → 按采样网格逐帧求值 → 交出帧载体 → 编码出片。帧是算出来的，没有可采样的外部原件。

**这里唯一的职责是分发**：判断任务属于哪一类，用 `skill` 工具加载**恰好一个**模块 skill，然后按那个 skill 的指令做。路由根自己给方案即失败。

## 四条不变量（所有模块 skill 共用，写任何代码前先对齐）

1. **总时长是编译产物**。剧本里没有「全片总长」这个输入；链上窗口累加（重叠相减）得出总长。出现「全片总长 / 进度百分比 / 第 n 帧共 N 帧 / 按时间反查该画哪一镜 / 自建时间表」即判偏离。
2. **时间语义是毫秒，`fps` 只是采样密度**。调高 `fps` 不让视频变短，只让同一时长有更多采样点；单元有效帧率三级继承：单元 `fps` > spawn 链 `fps` > `RenderOptions.fps`。
3. **确定性注入面固定**：`fps`、宽高、`seed`、输入事件表、`assets`。任一项不同就是另一次推演；预览与导出必须传同一份。
4. **验证用可计算判据**：能写成测试、能跑 `compute.computeAt`、能比帧指纹的才算验证过；「看起来对」不算。

## Registry

| Skill | 它负责 | 加载它当 |
| --- | --- | --- |
| `codevideo-scene` | 单幕剧本：`start` / `env.step` / 上下文能力集 / 状态聚合 | 从零写第一段能出帧的剧本，或改 `step` 回调里的画面与状态 |
| `codevideo-schedule` | 多幕链：`cutTo` / `transitionTo` / `par` / `loop` / `spawn` / `layer` / 消杀 | 把多段拼成一条链、处理幕间过渡与并行分支、控制 spawn 生命周期 |
| `codevideo-audio` | 声音：组合子、包络、总线图、运行期句柄、`once` 去重 | 加声音、路由总线、侧链、写参数轨迹、决定声音何时收 |
| `codevideo-export` | 出片：`render` 全流程、`Exporter` 五形态、透明帧的声明与封装、预览宿主、帧载体所有权 | 在浏览器出 mp4 / webm（含透明）或透明 APNG、接预览、注入画布或 painter、排查「没有帧来源」类报错 |
| `codevideo-verify` | 验证：`validate` / `compute` / 帧指纹 / 连续性 / 早停 | 不整片渲染就想确认时间与画面、给改动写回归测试、判定确定性 |

## 选择规则

- **只加载一个**。任务真的有两个互不重叠的角度时最多两个，三个是上限。
- 按**对象 → 阶段 → 具体**路由：先判对象（剧本 / 声音 / 出片 / 验证），再判阶段（写新还是改旧），最后选最窄的那个。
- 已经点明缺陷类别就直接路由并停止，不要再加载泛化 skill。
- 拿不准时选最窄的：窄了漏一点可以补，宽了会灌进无关约束。
- `codevideo-verify` 与其余 skill 不冲突：先写完再验证是正常顺序，但同时加载两个写作类 skill 会互相打架。

## 判定树

1. 任务完全与视频引擎无关（做 UI、写后端、配构建）？→ **`no skill needed`**，直接做，别加载。
2. 要确认「跑出来对不对、时间对不对、两次是否一致」？→ `codevideo-verify`。
3. 要出片、接预览、注入画布或 painter、处理帧载体？→ `codevideo-export`。
4. 要发声或改声音的构成（增益、包络、变速、总线、侧链、参数轨迹）？→ `codevideo-audio`。
5. 要多段拼接、幕间过渡、并行分支、spawn 生命周期？→ `codevideo-schedule`。
6. 其余写剧本的活（一段幕里的逐帧画面与状态）？→ `codevideo-scene`。

目标不清时先问一个短问题，再加载。

## 源码是唯一事实来源

每个模块 skill 都指向契约源码；签名、缺省值、错误行为一律以源码为准：

| 要查什么 | 读哪里 |
| --- | --- |
| 剧本与上下文的能力集 | `packages/contracts/src/scene/entities.ts`、`scene/nodes.ts`、`scene/layers.ts` |
| 消杀与句柄 | `packages/contracts/src/scheduler/entities.ts` |
| 音频端口 | `packages/contracts/src/audio/ports.ts`、`graph.ts`、`entities.ts` |
| 捕获与导出 | `packages/contracts/src/capture/ports.ts`、`export/ports.ts` |
| 入口配置 | `packages/contracts/src/entry/ports.ts` |
| 错误与校验 | `packages/contracts/src/feedback/entities.ts` |

不要凭印象写 API：先用 `grep` 确认导出名、参数、缺省值，再落笔。

## 不覆盖

本组 skill 只管用这套契约写剧本、加声音、出片与验证。它不管通用 TypeScript 写法、构建工具选型、CI 平台配置、产品设计。真障碍在这些方面时直接说明，不要加载最接近的 skill 硬凑。

## 加载方式

用 `skill` 工具、传**精确名字**（如 `skill("codevideo-audio")`）。不要用 `read` 直接读 `SKILL.md` 绕过——`skill` 工具才是受支持的路径。
