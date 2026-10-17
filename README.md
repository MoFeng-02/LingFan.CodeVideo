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
- **音频**：时间线事件（不占帧池、不改 step 模型）；多实例并存，支持音量/淡入淡出/循环/声道/立体声摆位；导出走确定性离线混音，预览走 WebAudio 预排。

## 文档

- 规约索引：[私有文档/CodeVideo规约/README.md](私有文档/CodeVideo规约/README.md)
- 开放问题与实现裁决：[11 号 RFC](私有文档/CodeVideo规约/11-rfc-open-issues.md)（§9 实现裁决表，含 §9.2 变帧率、§9.3 音频、§9.4 forever 循环）
- 契约设计规则：[13 号](私有文档/CodeVideo规约/13-contract-design.md)
- 目录规划：[14 号](私有文档/CodeVideo规约/14-directory-plan.md)
