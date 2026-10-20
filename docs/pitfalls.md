# 反例台账：写出来像对、其实是错的写法

本页是**反例集**，按内容组织：每行四样东西——错法片段、为什么会错的一句话机制、对照的正确写法、能抓住它的钉子。

钉子的含义是固定的，只有两种：`tests/*.test.ts` 里**真实存在**的用例，或一条能跑的门禁命令。
查不到防线的写法统一进文末「无自动防线」，那里写「靠评审拦截」——不编测试名。

组按「模型与新人最容易在哪个环节自己发明语义」排。四层与双池的定义在 [`mental-model.md`](mental-model.md)，术语对齐在 [`glossary.md`](glossary.md)，本页只管对照。
数值一律带单位：毫秒、帧/秒、像素、0..1、dB。

## 时间模型

本组判据：语义层只有毫秒一条轴，`fps` 只决定采样密度，总长是链算出来的结果而不是输入参数。

| 错法（✗） | 为什么错 | 正确写法（✓） | 钉子 |
| --- | --- | --- | --- |
| `if (t >= 12345) drawAct2();`（在回调里按绝对毫秒反查该画哪一幕） | 段随链推进，画哪一幕由链的位置决定；反查把链退化成手写数组 | `env.cutTo(3000, (prev, env) => { env.step(3000, ...) })` | `tests/transition-overlap.test.ts`「两段在窗口内同帧求值，总长按共享段扣减」 |
| `const p = ctx.t / ctx.totalTime;` 驱动单元内动画 | 跨单元比值不受本段窗口约束，改一段时长全片动画一起变形 | `ctx.progress`（= `localT / duration`，0..1） | `tests/wait-update.test.ts`「与并行 step 同窗：回调点 = 采样网格点，自身不额外产帧」（progress = 0 / 0.25 / 0.5 / 0.75） |
| 想"放快四倍"就把 `fps: 240` 往上报 | `fps` 是采样密度，调高只是采样点更密，时长纹丝不动 | 缩短窗口毫秒：`env.step(750, ...)` | `tests/engine-timeline.test.ts`「单元 fps 覆盖基础帧率：高帧率单元采样点更密」 |
| `t += 1000 / fps;` 逐帧累加时间戳 | 浮点累加在 fps 不整除时与真值分叉，误差随帧数放大 | `ctx.t`，或按帧号乘：`frameIndex * (1000 / fps)` | `tests/time-math.test.ts`「乘法与累加在 fps 不整除时不同（乘法是唯一正解）」 |
| 拿子单元的 `ctx.frameIndex` 与父单元的同号帧当同一时刻 | 单元有效帧率三级继承，帧号密度不同，跨单元不可比 | 用毫秒对齐：`ctx.t` | `tests/time-math.test.ts`「timestampAt = frameIndex * (1000/fps)，恒等乘法」 |
| `env.wait(500, () => draw());` 想每帧画一次 | wait 不产帧，纯空窗没有采样点 | 要逐帧就用 `env.step(500, (ctx) => { ... })` | `tests/wait-update.test.ts`「纯空窗：没有任何产帧单元 → 零帧零回调」 |
| 跨幕动画用 `ctx.f(n)` 一帧帧推 | `f(n)` 的参照系是本单元有效帧率，只在本单元内有意义 | 跨幕用 `coverProgress(atMs, fromMs, durationMs)` | `tests/cover-progress.test.ts`「窗内线性推进，且首尾相接」 |

## 登记期 vs 运行期

本组判据：登记期（`env`）只登记、不执行画面；运行期（`ctx`）才有画布、声音句柄与推进能力。两边能力集刻意不同。

| 错法（✗） | 为什么错 | 正确写法（✓） | 钉子 |
| --- | --- | --- | --- |
| 在 `cutTo` 体里读"当前帧时刻"：`cutTo(1000, (prev, env) => { const p = env.localT; })` | 登记体只跑一次（干跑），没有当前帧这回事，更没有 `localT` | 时间只能在 `env.step` 回调里读 | `tests/validate-pool.test.ts`「body 干跑抛错 → spec_violation」（干跑 = 登记体不产帧地跑一遍） |
| 把 `env.spawn(...)` 的返回值存起来后面 `kill()` | 登记期返回的是占位死句柄（`alive === false`），真句柄只在运行期产生 | 运行期 `ctx.spawn(...)` 的返回值才是活句柄 | `tests/dsl-chain.test.ts`「spawn 返回占位死 Handle（alive=false；真 Handle 在运行期 ctx.spawn）」 |
| 把 `AudioHandle` 存在模块变量里，到了别的帧再 `stop()` | 句柄操作面只在本回调内有效，操作以当前回调时间为生效时刻 | 在发它的那一次回调里决定何时收：`h.stop(200)` | `tests/audio.test.ts`「回调之外操作句柄报 spec_violation（操作面只在 step/loop 窗口内有效）」 |
| 以为运行期 `ctx.spawn` 的异步 `setup` 会卡住帧或丢资产 | 帧内只登记链壳，异步等待发生在帧与帧之间，链从 spawn 之后第一个采样点整点开始 | 直接写 `setup: async () => { ... }`，让引擎在帧边界物化 | `tests/spawn-async-setup.test.ts`「链从 spawn 之后的第一个采样点整点开始，内容本地时间从 0 起算」 |
| 在 `run` 里读 `env.assets` | `assets` 只挂在 `SetupEnv` 上，run 阶段拿不到 | 资产加载写在 `start({ window, setup, run })` 的 `setup` 里 | `pnpm typecheck`（`setup` 之外的 `env` 没有 `assets` 成员） |
| 以为 `setup` 每帧都跑、或每个 spawn 实例各跑一次 | 它是一次推演里的单次准备，资产只解码一次 | 把一次性准备全放 `setup`，逐帧逻辑放 `run` / `step` | `tests/asset-contract.test.ts`「同一场景在一次推演里只跑一次 setup（资产只解码一次）」 |
| `env.transitionTo(next)` 之后继续 `env.step(...)` 想画下一幕内容 | 过场登记后后续节点在运行期被短路，登记了也不会执行 | 下一幕的内容写进 `next` 自己的 `cutTo` 体 | `tests/dsl-chain.test.ts`「transitionTo 登记：其后节点在运行期被短路（编译 break），登记本身不抛」 |
| 每帧都发同一句声音，用 `if (ctx.frameIndex === 0)` 之类自己判首帧 | 判首帧在多单元/多 spawn 下会重复，且改 fps 就失效 | `ctx.once("unit", (c) => c.audio(clip("hit")))` | `tests/once.test.ts`「unit：整个 step 窗口只发一次（默认作用域）」 |

## 池与窗口

本组判据：总毫秒池记时长（`Σstep + Σwait + Σpar-max`），帧窗池记采样点（只由 step/loop 的采样密度贡献）。

| 错法（✗） | 为什么错 | 正确写法（✓） | 钉子 |
| --- | --- | --- | --- |
| 以为 `wait` 不占时间、可以白给 | wait 占总毫秒池，只是不产帧 | 有画面就 `step`，纯等待才 `wait` | `tests/validate-pool.test.ts`「池消耗 = Σstep + Σwait + Σpar-max」 |
| `env.loop({...}); env.step(500, ...)` 想让 step 接在 loop 之后 | loop 在后台重复，不推进父游标 | 后续内容要接在 loop 之后，就把它放进 loop 体内或另起一段 | `tests/engine-timeline.test.ts`「loop 不推进 cursor：后续 step 仍在 loop 登记处的时间上开始」 |
| 以为不带 `ms` 的 loop 也占满时长 | 无 `ms` 的 loop 靠 `next()` / `stop()` 自管节奏，池消耗为 0 毫秒 | 要固定迭代窗就写 `ms`：`env.loop({ ms: 100, times: 3 })` | `tests/validate-pool.test.ts`「loop 池：ms×times；无 ms（自管节奏）= 0 不占池」 |
| 以为 `par` 的两条分支时长相加 | 分支共享同一段时间线，取最长的一条 | 并行分支按最长的安排预算 | `tests/validate-pool.test.ts`「池消耗 = Σstep + Σwait + Σpar-max」 |
| 以为 `at` 越窗会被夹到窗口尾部 | 越窗是静态违规，引擎不猜作者意图 | 让 `at` 落在本段窗口内：`env.step(100, fn, { at: 900 })` 且窗口 ≥ 1000 毫秒 | `tests/validate-pool.test.ts`「f(90) 越窗：at 越窗 → window_overflow」 |
| 把 `forever: true` 当"跑满 N 毫秒就停"的定时器 | `forever` 是寿命铺到总时间线尾，或等显式 `kill()` | 要有限时长就写 `duration`，要保活才写 `forever` | `tests/engine-timeline.test.ts`「跨段背景：forever spawn 存活到时间线尽头」 |
| `env.spawn(bg, { forever: true, duration: 500 })` 两个都写 | 寿命二义：既保活又限时，编译期直接拒 | 二者取一 | `tests/validate-pool.test.ts`「spawn forever 与 duration 并存 → spec_violation（寿命二义）」 |

## 生命周期

本组判据：消亡不是开关。要么瞬间出池，要么开一个长度毫秒的消亡窗口，窗口内继续逐帧求值。

| 错法（✗） | 为什么错 | 正确写法（✓） | 钉子 |
| --- | --- | --- | --- |
| `handle.kill({ fadeOut: 100 })` 之后以为下一帧就没了 | 消亡窗口内目标仍在池、仍逐帧求值，窗口结束才出池 | 在回调里读 `ctx.disposing` / `ctx.disposeProgress`，自己画消失过程 | `tests/dispose.test.ts`「窗口内继续求值并暴露 disposing/disposeProgress，窗口结束出池」（t=150 毫秒时 progress=0.5） |
| `handle.kill()` 之后期待画面有淡出 | 缺省是立即出池，没有补间 | 要淡出必须显式给 `fadeOut` | `tests/dispose.test.ts`「不带 fadeOut = 立即死（之后不再绘制）」 |
| 用新 key 再 `spawn` 一次，想"延长"同一条背景 | 新 key 就是新实例，两条链会重叠 | 同 key 续接：`ctx.spawn(bg, { key: "bg" })` | `tests/engine-timeline.test.ts`「同 key 二次 spawn 续接（不重叠新建）」 |
| `spawn` 时 `duration: -100` 想表达"从尾部反向算" | 负时长是非法值，不是相对写法 | 写正的毫秒数，或省略走场景自身时长 | `tests/validate-pool.test.ts`「spawn 负 duration → spec_violation」 |
| 以为 `scheduler.kill(name)` 只能杀 spawn 链 | 具名消杀同时覆盖 step / loop 单元与 spawn 链 | 给单元起 `id`：`env.step(500, fn, { id: "title" })`，再 `ctx.scheduler.kill("title")` | `tests/dispose.test.ts`「par 分支里按 id 杀另一个分支的单元，带消亡窗口」 |
| 宿主 `dispose()` 之后再 `start()`，期待继续发声 | 终点之后的投递一律不生效，不静默降级 | 重建前先 `begin(program)` | `tests/web-audio-player.test.ts`「dispose 之后再 start：不再投递任何消息」 |
| `kill` 与 `dispose` 当成两套语义各写一遍 | 两者同义，都接受同一个 `KillOptions` | 只挑一个名字用，团队内统一 | `tests/dispose.test.ts`「主链单元自消杀 + fadeOut：窗口内继续画，窗口结束停」 |

## 音频

本组判据：声音的时钟独立于画面。它不占帧窗池、不因幕/段/链边界被自动杀，预览与导出走同一套混音内核。

| 错法（✗） | 为什么错 | 正确写法（✓） | 钉子 |
| --- | --- | --- | --- |
| 用同一套 `at` 语义贯穿登记期与运行期 | 两套语义并存：登记期 `at` 相对登记位置，运行期 `at` 相对发射时刻 | `env.audio(clip, { at: 100 })` 是位置；`ctx.audio(clip, { at: 200 })` 是延迟 | `tests/audio-emit-delay.test.ts`「at 相对发射时刻：t=100 发射 + at 200 → 起播 300」与「登记期 at 仍相对登记位置（两种语义并存）」 |
| 在幕边界手动 `ctx.audio(...).stop()` 收声音 | 引擎不因幕、段、链边界自动杀声音，手动收会截断尾音 | 用 `ctx.once` 决定何时发，用句柄 `stop({ fadeOut })` 或 `dispose` 决定何时收 | `tests/audio-warp-ops.test.ts`「loop 到终界：endMs 夹在总时间线尾（引擎不因幕边界杀声音）」 |
| `rate: -1` 想倒放 | 变速恒正，倒放不支持；负值在构造处就被拒 | 只做加速/减速，反向段落提前在源里准备好 | `tests/audio-warp-combinator.test.ts`「其它组合子守住量纲与范围（rate>0 / pan∈[-1,1] / gain≥0）」 |
| `curve([300, 1], [100, 0])` 折点写反 | 折点时间必须严格递增，乱序是违规不是自动排序 | 时间升序写：`curve([100, 0], [300, 1])` | `tests/envelope.test.ts`「curve 折点时间未严格递增 → spec_violation」 |
| 以为登记期 `audio` / `bgm` 占帧窗池或推进游标 | 音频声明不改 step 模型，不消耗帧窗池 | 声音按需声明，画面时长仍只由 step / wait 决定 | `tests/dsl-chain.test.ts`「audio / bgm 登记不抛、不推进 cursor（不占帧窗池）」 |
| 把 `{ db: -6 }` 当线性系数 0.6 自己算混音 | dB 与线性幅度是同一量的两种记法，换算只有一处实现 | 交给平台侧：作者写 `{ db: -6 }`，适配器收线性幅度 | `tests/gain-units.test.ts`「dB 写法与等值线性写法产出同一份样本」 |
| 预览与导出各写一套混音（或按块大小分别调参） | 双端同源，逐样本相同；块尺寸只影响循环次数 | 只写一份音频图，两个端各自注入 `AudioClock` / `AudioOutput` | `tests/audio-parity.test.ts`「恒速正弦：预览路径与导出路径完全相同」与「块尺寸只影响循环次数：128 / 512 / 整段给出同一份样本」 |
| 用 `if (t === 300) h.setGain(0.2)` 事先算好"第几帧该改" | 句柄操作的生效时刻就是求值时刻，提前算等于自己排出第二份生效时刻表 | 在要生效的那一帧回调里调用 | `tests/audio.test.ts`「句柄操作记录到 voice.ops（stop / setGain / setRate，时刻=求值时刻）」 |

## 捕获与导出

本组判据：帧载体是借出物，所有权随 `writeFrame` 转移；写帧、写音、`finalize` 的次序是纪律，不是建议。

| 错法（✗） | 为什么错 | 正确写法（✓） | 钉子 |
| --- | --- | --- | --- |
| 用 `frames: "allow-blank"` 当性能开关，想把每帧回读省掉 | 它只把「没有帧来源」从报错降级成全 0 占位位图；有 2D 上下文时照样整幅回读 | 预览注入 `painter` 自绘：`painter: () => ({ data: new Uint8ClampedArray(4), width, height })` | `tests/frame-source.test.ts`「显式 frames:"allow-blank" 才给零位图」（该用例前提是 `getContext: () => null`，无源才有占位）；回读路径见同文件「缺省从绘制目标画布回读」 |
| 边写帧边写音频块，或先写音频再补帧 | 次序固定：帧全写完 → 音频块按时间顺序连续提交 → `finalize` | 让引擎排序，不要在导出器里自行交错 | `tests/export-audio.test.ts`「帧全部写完后才写音频块，音频写完才 finalize」 |
| 有声音但导出器没有 `writeAudio`，就静默只出视频 | 静默降级会让成品少一条轨而没人报错 | 要么实现 `writeAudio`，要么让引擎报 `spec_violation` | `tests/export-audio.test.ts`「有声音但导出器不支持音轨 → spec_violation」 |
| 有声音但不注入 `AudioClock` | 没有采样率与声道，音轨无法布局 | 注入 `audio?: AudioClock`，布局取自它声明的 `sampleRate` / `channels` | `tests/export-audio.test.ts`「有声音但没有 AudioClock → spec_violation」 |
| 把 `fps` 与 `width` / `height` 之外的尺寸帧塞给导出器 | 写帧前先校验尺寸，晚校验会把错帧写进编码器 | 让 `RenderOptions` 的尺寸与导出尺寸一致 | `tests/webcodecs-exporter.test.ts`「尺寸与导出尺寸不一致：写帧前报 spec_violation」 |
| 在 `FrameHost` 里跨 `begin` 保留上一段推演的状态 | `begin` 是每次推演的重置点，状态不得跨 `begin` 沿用 | 每次 `begin(info)` 重建内部计数器与缓冲 | `tests/frame-host.test.ts`「重播会重新 begin：跨帧状态不串到下一段推演」 |
| 用异步 `painter` 时并发取帧（不 await、任其重叠） | 引擎等取帧完成再交帧，取帧慢不丢帧且严格串行；并发会把帧序打乱 | 直接把 `async` 函数当 `painter` 返回，让引擎等 | `tests/async-painter.test.ts`「取帧慢也不丢帧，且严格串行（不重叠取帧）」 |
| `begin` 失败后继续 `frame(...)`，或失败时仍调 `close()` | `begin` 失败即整段推演失败，不交帧也不调 `close` | 把 `begin` 的错误原样上抛 | `tests/frame-host.test.ts`「begin 失败：整个推演失败，不交帧也不调 close」 |
| 透明档下少清一次屏（「反正要透明，留点旧像素也没关系」） | 两档的区别只是「干净」是哪种干净；漏清会让上一帧的像素留成鬼影，输出就与上一帧有关了 | 每帧照样清，透明档 = 清成全透明 | `tests/alpha-frames.test.ts`「Canvas2D 合成器按 alpha 档创建上下文」 |
| 用 mp4 导出器出透明帧，指望透明区域自己留着 | H.264 结构上没有 alpha 通道，透明处会被填黑；声明 `alpha: "alpha"` 却配 mp4 封装，首帧前就报 `spec_violation` | 要透明产物就配 `ApngExporter`，或用 `FrameSequenceExporter` 拿原始 RGBA 自己落盘 | `tests/alpha-frames.test.ts`「声明 \"alpha\" 却用 mp4 封装：首帧前报错，且不写任何帧」 |
| 在导出器里写「拿不到位图就 `getImageData` 兜底」 | 导出器回读把编码降级成事后补救，还掩盖了「这台设备没有 2D 上下文」的装配错误 | 在帧来源这一侧声明要位图：`createReadbackHost(inner)` 包一层 | `tests/readback-host.test.ts`「非 2D 设备明确报错，而不是交一张黑帧」 |

## 契约纪律

本组判据：契约是零实现的类型层，能力靠注入。三条红线：不引运行期依赖、不开平行类型、不绕开组合根。

| 错法（✗） | 为什么错 | 正确写法（✓） | 钉子 |
| --- | --- | --- | --- |
| 手写 `{ url: "a.mp3", kind: "audio" }` 当音频传 | `AudioClip` 带 brand，结构相同的普通对象不是合法的片段 | 用工厂：`env.audio(clip("a.mp3"))` | `pnpm typecheck`（结构相同的对象在编译期就被拦下） |
| 业务代码自己 `new TimelineEngine(...)` 并手动拼装配 | 装配出现在两处，缺一个依赖就静默跑偏 | 走 `render(scene, options)` 的注入面（`exporter` / `assets` / `painter` / `audio`） | `tests/dsl-chain.test.ts`「assets.load 未装配 AssetSource → spec_violation；经组合根 render 注入默认实现 → fail-fast」 |
| 以为可选注入缺了会自己降级 | 缺装配是 fail-fast，不是降级 | 需要的能力就显式注入，不赌缺省 | `tests/frame-source.test.ts`「无 painter 且无 2D 上下文 → spec_violation（不静默交空白帧）」 |

## 无自动防线

下面这些写法目前没有测试或门禁能抓到，**靠评审拦截**。列在这里是为了让评审有明确清单，而不是让它们变成可接受的写法。

| 错法（✗） | 为什么错 | 现状 |
| --- | --- | --- |
| 把 `spawn` 的 `at` 当绝对时间线时刻 | `at` 相对登记位置；同族的 `step.at` 有越窗防线，`spawn.at` 暂无 | 靠评审拦截；越窗语义可参照 `tests/validate-pool.test.ts`「f(90) 越窗：at 越窗 → window_overflow」 |
| 在 `packages/contracts` 里写实现、或读运行时全局（`window` / `navigator`） | 契约零实现依赖，加了实现就变成第二个组合根 | 靠评审拦截：只允许 `interface` / `type` / `declare` |
| 从别的包的内部路径 import（不经包入口 `index.ts`） | 绕过公共出口，内部改名就断 | 靠评审拦截：包入口是唯一合法入口 |
| 同一概念另开一份平行类型（自己再定义一遍帧载体或错误形状） | 两份声明迟早分叉，端口之间对不上 | 靠评审拦截：先检索，有就复用 |
| 以为 `validate` 通过就等于运行时不会出错 | 它只做静态检查并干跑登记体，不替代运行期校验 | 靠评审拦截：错误仍按 `RenderError` 的 `kind` 分别处理 |
| 跨帧持有 `FrameHandle`，或 `writeFrame` 之后再 `close()` | 所有权随 `writeFrame` 转移，句柄交给引擎后立即释放 | 靠评审拦截：导出实现不得跨帧留句柄 |
| 以为 mp4 容器字节能逐字节复现 | 判据是帧指纹序列，不是容器字节；容器含编码器与封装侧差异 | 靠评审拦截：确定性结论只对指纹序列成立 |
