---
layout: page
sidebar: false
aside: false
---

<div class="cv-landing">

# 画面是时间的函数

**LingFan CodeVideo** 是一个确定性推演式视频引擎：视频不是文件，是一个跑 N 毫秒的自动游戏。画面是时间 t 的确定性函数——同一份剧本，每次推演逐帧相同；总时长是编译产物，不是设计参数。

<HeroEngine />

这段画面由一份三幕剧本实时推演：幕间 `transitionTo` 重叠 150ms，总时长 1700ms = 600 + 800 + 600 − 2 × 150，由链编译得出。多看两遍——逐帧相同。

[心智模型](/mental-model) · [第一段画面](/guides/first-clip) · [契约总览](/contracts/index) · [常见错法](/pitfalls)

</div>

## 验证不必出片

出片之前就能验证：`validate` 干跑登记体检查结构；`compute.computeAt` / `compute.computeRange` 用 headless 引擎按需开窗取样，只取需要的时间区；帧指纹比对两次推演是否逐帧一致。下面是 compute 取样的活演示——曲线是 `computeRange` 取回的状态点连成的线，表格是 `computeAt` 取回的选中点状态表：

<TimeProbe />

## 30 秒上手

```bash
pnpm install
```

剧本是普通的 TypeScript：登记期只登记，不画任何一帧；画面在推演期逐帧求值。

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const scene = start(1000, (env) => {
  env.step(1000, (ctx) => ({ t: ctx.localT }));
});

await render(scene, {
  fps: 30,
  width: 640,
  height: 360,
  headless: true,
  frames: "allow-blank",
  exporter: new FrameSequenceExporter(),
});
```

## 接下来读什么

| 想做什么 | 读哪页 |
| --- | --- |
| 理解「画面是 t 的函数」与四层模型 | [心智模型](/mental-model) |
| 写出第一段逐帧画面 | [第一段画面](/guides/first-clip) |
| 把多幕拼成链、处理过场与并行 | [幕间与链](/guides/compose-acts) |
| 给画面加声音 | [加声音](/guides/add-audio) |
| 导出 mp4 / 接预览 | [出片与预览](/guides/export-mp4) |
| 不出片就验证确定性 | [取样验证](/guides/debug-with-compute) |
| 查某条契约的准确语义与判据 | [契约总览](/contracts/index) |
| 对照常见写法错误 | [常见错法](/pitfalls) |

<style>
.cv-landing {
  padding-top: 32px;
}
.cv-landing h1 {
  text-align: center;
  margin-bottom: 12px;
}
.cv-landing > p:nth-of-type(1) {
  text-align: center;
  max-width: 40em;
  margin-left: auto;
  margin-right: auto;
  opacity: 0.9;
}
.cv-landing > p:nth-of-type(3) {
  text-align: center;
  font-size: 14px;
}
</style>
