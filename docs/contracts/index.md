# 契约总表

引擎的能力面按域切开：每个域在 `packages/contracts/src/<域>/` 下只用类型与注释声明形状，实现一律落在 `packages/core` 或 `packages/infra`，由组合根 `packages/core/src/index.ts` 装配。这份总表回答一件事：想做某件事时该读哪个域、该域承诺了什么、细节在哪一页。

## 域表

| 能力 | 端口源码路径 | 主要承诺 | 文档页 |
| --- | --- | --- | --- |
| 时间：任一采样点上的时刻、帧号、总长、步长 | `packages/contracts/src/time/ports.ts`、`packages/contracts/src/shared/units.ts` | 时间语义单位是毫秒；帧号→毫秒只能逐帧乘法 `frameIndex * (1000 / fps)`，禁累加；`fps` 只决定采样密度，不改同一时刻上的语义 | `docs/contracts/time.md` |
| 剧本：用代码声明「第几毫秒画什么」 | `packages/contracts/src/scene/entities.ts`、`scene/nodes.ts`、`scene/layers.ts`、`scene/random.ts` | 登记期只声明节点、不执行画面；总长由链上窗口累加得出，重叠窗相减；单元有效帧率三级继承；逐帧回调按单元类型给不同能力集 | `docs/contracts/scene.md` |
| 调度：运行期控制某条链活多久、何时消失 | `packages/contracts/src/scheduler/entities.ts` | `key` 相同即续接同一实例而不是新建；消亡窗口内仍逐帧求值；`forever` 铺到时间线尾，显式 `kill` 才提前结束 | `docs/contracts/scheduler.md` |
| 捕获：把每一帧交给宿主或导出器 | `packages/contracts/src/capture/ports.ts` | 帧载体分 CPU 位图与设备句柄两支，句柄所有权随交出转移；`begin` 后逐帧调用且引擎逐帧等待，不得并发重入 | `docs/contracts/capture.md` |
| 导出：把帧序列与音轨封成产物 | `packages/contracts/src/export/ports.ts` | 帧与音频块都在 `finalize` 之前写完，音频块按时间顺序连续提交、拼接即整轨；产物元信息随 `finalize` 一次给出 | `docs/contracts/export.md` |
| 音频：登记声音、路由总线、两端输出 | `packages/contracts/src/audio/`（`entities.ts` / `graph.ts` / `synth.ts` / `gain.ts` / `ports.ts`） | 登记声音不消耗帧窗池；总线拓扑只在 `bus` 处定，同 id 重复登记以最后一处为准；导出端与预览端是两条输出端口 | `docs/contracts/audio.md` |
| 资产与输入：setup 阶段取素材、按时刻取输入快照 | `packages/contracts/src/asset/entities.ts`、`asset/ports.ts`、`input/entities.ts`、`input/ports.ts` | 素材只能在 setup 加载，`run` 阶段拿不到；输入是声明式事件表，同一时刻查询必得相等快照 | `docs/contracts/asset-input.md` |
| 反馈：读状态、接失败、做静态检查 | `packages/contracts/src/feedback/entities.ts` | 状态按 `段标识/单元键` 聚合；错误对象带闭集 `kind` 与毫秒级 `cursor`；静态检查返回数组，空数组即通过 | `docs/contracts/feedback.md` |
| 入口：一次推演的配置与结果 | `packages/contracts/src/entry/ports.ts` | `fps` / `width` / `height` / `exporter` 必填，其余可选项都有缺省与明确的省略行为；缺帧来源时报错而不是静默交空白帧 | 不单独成页，字段按落点解释：`docs/contracts/capture.md`（`painter` / `frames` / `headless`）、`docs/contracts/export.md`（`exporter` / `audio` / `onProgress`）、`docs/contracts/asset-input.md`（`assets` / `input`）、`docs/contracts/scene.md`（`seed`） |

## 读法

1. 先读 `docs/mental-model.md` 的六条不变量，再读本表。域页只解释单个域的语义，不重复讲时间线怎么编译。
2. 选域只按「我要做的事」找行，不按类型名找。要判某件事能不能做，先读该域端口源码里的成员注释——注释就是承诺，注释里没有的能力，实现里出现就是越界。
3. 域页不重复声明类型签名：签名以 `packages/contracts/src/` 下的源码为准，域页只解释单位、缺省值、省略时发生什么、边界在哪。
4. 判据优先：想知道某条承诺是否成立，先跑该页「断言表」钉子列的测试，再决定要不要读实现。`docs/README.md` 的三条读法约定同样适用。

## 契约纪律

- **零实现依赖**：`packages/contracts` 不 import 任何外部包、不含运行期代码、不抛异常也不做校验。要让契约里塞进一段逻辑时，那段逻辑应该去 `packages/core`，契约只留形状与注释。
- **依赖方向单向**：`contracts` ← `core` / `infra` ← 消费方；`infra` 与 `core` 互不依赖，组合根在 `packages/core/src/index.ts`。反向 import 一律禁止——`contracts` 不知道 `core` 存在，也不知道任何适配器叫什么名字。
- **禁平台 API**：`packages/contracts` 内不出现 `window` / `document` / `localStorage` / DOM / GPU / 原生桥。平台能力全部经端口注入，实现放 `packages/infra`；因此同一份契约既能在浏览器里跑，也能在无 DOM 的进程里跑。
- **能力即上下文**：引擎不给全局单例。声音、总线、随机、spawn 都挂在回调拿到的 `ctx` / `env` 上，没有 `ctx` 就调用不到——这是「契约里没有的能力实现里出现就是越界」的运行时体现。
- **契约不变则实现零外溢**：替换适配器（换导出格式、换渲染后端、换音频时钟）只改组合根的装配行，不改剧本与端口。

## 相关

- 相邻页：`docs/README.md`（文档索引与三条读法约定）、`docs/mental-model.md`（时间线如何编译的四层理解与六条不变量）、`docs/glossary.md`（术语表）、`docs/pitfalls.md`（反例台账）
- 契约包出口：`packages/contracts/src/index.ts`（只转发各域 barrel，本身不含实现）
