# 文档索引

本目录是**公开文档**：写剧本、接导出、写适配器的人（以及直接照文档生成代码的模型）都从这里进。
它按「你手头要解决什么」组织，不按目录树组织。

本目录只写公开事实：类型怎么用、语义承诺是什么、错了会怎样；不含内部讨论与历史沿革。

## 先读哪一页

| 你要做的事 | 读 |
| --- | --- |
| 第一次接触本仓，想知道它是什么 | [`mental-model.md`](mental-model.md) |
| 写第一段能出帧的剧本 | [`guides/first-clip.md`](guides/first-clip.md) |
| 把几百段拼成一条链、处理幕间过场 | [`guides/compose-acts.md`](guides/compose-acts.md) |
| 加声音、路由总线、写参数轨迹 | [`guides/add-audio.md`](guides/add-audio.md) |
| 在浏览器里出 mp4 | [`guides/export-mp4.md`](guides/export-mp4.md) |
| 不渲染整片就想验证画面/时间 | [`guides/debug-with-compute.md`](guides/debug-with-compute.md) |
| 查某个类型/端口的语义承诺 | [`contracts/`](contracts/index.md) |
| 我写的代码好像「不太对」但没报错 | [`pitfalls.md`](pitfalls.md) |
| 查术语的准确含义 | [`glossary.md`](glossary.md) |

## 目录结构

```
docs/
  README.md           本页：按任务索引
  mental-model.md     心智模型：一句话理解引擎，六条不变量
  glossary.md         词汇表（时间与采样 / 生命周期 / 契约角色 / 音频 / 确定性）
  pitfalls.md         反例台账：常见错法 → 为什么错 → 对照页
  contracts/          契约逐域说明（能力、承诺、边界、钉子）
  guides/             任务导向的五篇上手指南
```

## 文档与代码的对应关系

| 文档层 | 对应代码 | 说明 |
| --- | --- | --- |
| `contracts/*.md` | `packages/contracts/src/<域>/` | 逐域解释端口与语义承诺；签名以源码为准 |
| `guides/*.md` | `examples/` + `tests/` | 每篇都有可跑例子与指向测试的钉子 |
| `pitfalls.md` | `tests/` 中被钉死的反例 | 每条错法都能被某条测试或校验器抓到 |

## 三条读法约定

1. **签名以源码为准**：本目录不重复声明类型，只解释语义、单位、缺省与边界。
   文档与源码不一致时按源码修文档，不按文档改源码。
2. **判据优先**：每页都有「断言表」，断言列的钉子指向真实测试文件。
   想确认一件事，先跑对应测试，而不是读实现。
3. **术语一致**：写剧本、写注释都按 [`glossary.md`](glossary.md) 的收词，
   「幕 / 段 / 窗口 / 帧窗池 / 采样密度」各指一件事，混用会把不同机制读成同一件。
