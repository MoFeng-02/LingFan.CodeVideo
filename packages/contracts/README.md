# @lingfan-video/contracts

Code Video 引擎的契约层：**只有类型与语义承诺，没有实现、没有依赖**。

## 它是什么

全部端口与实体类型的唯一声明处，按域分目录：时间、调度、反馈、剧本、音频、输入、捕获、导出、资产、入口。
`core` 与 `infra` 都只依赖本包；本包不认识它们，也不认识任何平台 API。

## 怎么用

```ts
import type { Scene, RenderOptions, Exporter } from "@lingfan-video/contracts";
```

- **写剧本 / 调 API**：只需要本包的类型提示；每个字段的单位、取值域与缺省都写在成员 JSDoc 上，注释即承诺。
- **写适配器**：实现本包某个端口（`Exporter` / `FrameSink` / `AudioClock` / `AssetSource` / `Painter`），实现放 `infra` 或你自己的包，不要写进本包。
- **判断某个能力能不能做**：先在本包找对应端口的注释，再去找实现。契约里没有的能力，实现里出现就是越界。

## 三条纪律

1. **零实现依赖**：不 import 任何外部包，不含运行期代码，不抛异常也不做校验。
2. **依赖方向单向**：`contracts` ← `core` / `infra` ← 消费方；反向 import 一律禁止。
3. **不认平台**：不出现 `window` / `document` / DOM / GPU / 原生桥；平台能力全部经端口注入。

## 读什么

- 逐域语义与边界：[`docs/contracts/`](../../docs/contracts/index.md)
- 心智模型（登记期 / 编译期 / 推演期 / 交出）：[`docs/mental-model.md`](../../docs/mental-model.md)
- 术语的准确含义：[`docs/glossary.md`](../../docs/glossary.md)
