# 资产与输入（AssetLike / AssetKind / AssetSource / InputEvent / InputSnapshot）

两块外部数据接进推演的端口：资产是「剧本要用的素材怎么拿到」，输入是「声明式事件表怎么变成某一时刻的只读快照」。资产端口在 `packages/contracts/src/asset/ports.ts` 与 `packages/contracts/src/asset/entities.ts`，输入端口在 `packages/contracts/src/input/ports.ts` 与 `packages/contracts/src/input/entities.ts`；两者都由组合根注入实现。

## 何时用 / 何时不用

- 用：剧本要在登记期或运行期拿到图片、音频、模型等素材，因为 `AssetSource` 是唯一的取素材口。
- 用：素材来自打包器内联表、文件系统或第三方加载器，因为契约只约定「按 URL 拿到一个 `AssetLike`」，不约定协议与缓存策略。
- 用：画面要按事件表里的指针与按键状态变化，因为 `InputSnapshot` 是那一刻全部已生效事件的累积结果。
- 用：要在没有实时输入的环境里复现同一串画面，因为同场景加同事件表即得同帧序列。
- 不用：要在逐帧回调里直接写像素或直接播放声音，改用 `Painter`（见 `docs/contracts/capture.md`）与声音端口（见 `docs/contracts/audio.md`）。
- 不用：要按真实鼠标键盘驱动推演，本仓不做实时输入驱动；输入只能是声明式数据。

## 断言表

| 断言 | 判据 | 钉子 |
| --- | --- | --- |
| 异步 `setup` 经 `AssetSource.load` 拿到资产，`payload` 原样交给剧本 | 剧本收到的 `payload` 与加载器给的对象是同一个引用；300 毫秒 @10fps 出 3 帧 | `tests/asset-contract.test.ts` |
| `AssetKind` 是开放集合：适配器自定义的种类名原样透传，引擎不做种类分支 | 自定义种类名在剧本侧保持字面值不变 | `tests/asset-contract.test.ts` |
| 同一场景在一次推演里只跑一次 `setup` | `load` 只被调用一次 | `tests/asset-contract.test.ts` |
| 未装配 `AssetSource` 时 `assets.load` → `spec_violation`，由组合根装配的缺省实现 fail-fast | 错误正文含「未装配 AssetSource」 | `tests/dsl-chain.test.ts` |
| 无事件时快照是固定的空状态：指针在原点未按下、按钮表为空、按键集合为空、`lastEventAtMs` 为 `null` | 与缺省快照逐字段相等 | `tests/input-plane.test.ts` |
| 事件按 `atMs` 归一化，同刻保留声明顺序 | 同一时刻的两条事件按声明先后生效 | `tests/input-plane.test.ts` |
| 边界语义：`atMs` 等于查询时刻的事件已生效，大于查询时刻的不生效 | `snapshotAt(t)` 的包含关系 | `tests/input-plane.test.ts` |
| 多按钮按按下顺序累积，抬起只移除对应按钮 | 按钮表内容与顺序 | `tests/input-plane.test.ts` |
| 按键集合按 `down` / `up` 增删，自动重复不改变集合 | 集合大小不因 `repeat` 变化 | `tests/input-plane.test.ts` |
| 非法事件表在构建期报 `spec_violation` 并指出第几条 | 错误正文含条目序号与字段名 | `tests/input-plane.test.ts` |
| 回调里的快照与轨道在同刻查询结果相等，且同一帧的单元共享同一份快照对象 | 两个单元拿到的是同一个引用 | `tests/input-plane.test.ts` |
| 同一份事件表两次渲染得到同一串快照；`RenderOptions.input` 经组合根到达回调 | 两次推演快照逐字段相等 | `tests/input-plane.test.ts` |

## 用法

在 `setup` 里加载资产——`assets` 只在 `setup` 阶段可得：

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";
import type { AssetLike, AssetSource } from "@lingfan-video/contracts";

const W = 320;
const H = 180;

const source: AssetSource = {
  async load(url) {
    // url 原样传入，不做归一化；协议、编码、缓存都由实现决定
    const asset: AssetLike = { url, kind: "image", payload: { decoded: true } };
    return asset;
  },
};

const scene = start({
  window: 300,
  async setup(env) {
    const asset = await env.assets.load("todo://frame.png"); // 只在 setup 可得
    void asset.payload; // 引擎不读它，只保证原样往返
  },
  run(env) {
    env.step(300, () => {});
  },
});

await render(scene, {
  fps: 10,
  width: W,
  height: H,
  assets: source,
  painter: () => ({ data: new Uint8ClampedArray(W * H * 4), width: W, height: H }),
  exporter: new FrameSequenceExporter(),
});
```

声明输入事件表并在回调里读快照：

```ts
import { render, start } from "@lingfan-video/core";
import { FrameSequenceExporter } from "@lingfan-video/infra";
import type { InputEvent } from "@lingfan-video/contracts";

const W = 320;
const H = 180;

const input: readonly InputEvent[] = [
  { atMs: 0, kind: "pointer", type: "down", x: 0.2, y: 0.3 }, // button 缺省 primary
  { atMs: 100, kind: "pointer", type: "move", x: 0.4, y: 0.5 },
  { atMs: 100, kind: "key", type: "down", key: "Space" },
  { atMs: 250, kind: "pointer", type: "up", x: 0.4, y: 0.5 },
];

const scene = start(300, (env) => {
  env.step(300, (ctx) => {
    const snap = ctx.input; // 只读；同一帧所有单元共享同一份
    void snap.pointer.x; // 归一化 0..1，左上角为原点
    void snap.buttons; // 按下顺序
    void snap.keys; // 只读集合
    void snap.lastEventAtMs; // 尚无生效事件时为 null
  });
});

await render(scene, {
  fps: 10,
  width: W,
  height: H,
  input, // 声明式数据，不是实时输入
  painter: () => ({ data: new Uint8ClampedArray(W * H * 4), width: W, height: H }),
  exporter: new FrameSequenceExporter(),
});
```

自己实现事件轨道：`snapshotAt` 只读、无副作用，同一时刻多次查询得同一份快照。

```ts
import type { InputEvent, InputSnapshot, InputTrack, Ms } from "@lingfan-video/contracts";

class Track implements InputTrack {
  constructor(readonly events: readonly InputEvent[]) {}

  snapshotAt(t: Ms): InputSnapshot {
    // 只累计 atMs <= t 的事件；同一时刻保留声明顺序
    return {
      pointer: { x: 0, y: 0, down: false },
      buttons: [],
      keys: new Set<string>(),
      lastEventAtMs: null,
    };
  }
}

const track: InputTrack = new Track([]);
void track;
```

## 反例

- ✗ 写法：在 `run` 的逐帧回调里调 `env.assets.load(...)` 一边加载一边画 —— 为什么错：`assets` 只在 `setup` 阶段可得，逐帧里没有这个口，且资产加载不该混进帧求值；✓ 改成：在 `setup` 里加载完，把结果交给 `run` 里的剧本。
- ✗ 写法：`AssetSource.load` 里按 `kind` 分支返回不同形状的对象，期望引擎帮忙校验 —— 为什么错：引擎不解释资产内容、也不按种类分支，`payload` 是适配器私有产物，引擎既不做类型断言也不读；✓ 改成：把校验放在适配器内部，引擎侧只按自己的 `payload` 约定消费。
- ✗ 写法：把 `load` 的 `url` 先做一次归一化（补前缀、去查询串）再交给真实加载器 —— 为什么错：契约要求 `url` 原样传给实现方，归一化会让同一份剧本在不同实现下取到不同资源；✓ 改成：原样使用，需要改写就在剧本侧写清楚完整地址。
- ✗ 写法：在同一帧里让两个单元各自 `snapshotAt` 一次并比较引用 —— 为什么错：同一帧的单元共享同一份快照对象，比较引用恒为真，测不出任何东西；✓ 改成：比较快照内容，或直接断言 `toBe` 确认共享本身。
- ✗ 写法：给事件表乱序填写、指望实现按时间排 —— 为什么错：声明顺序就是同刻的生效顺序，乱填会让同刻事件的行为不可预期；✓ 改成：按 `atMs` 递增书写，同刻按需要的生效先后排列。

## 边界与陷阱

- `AssetKind`：开放联合，内置取值是 `"image"` / `"audio"` / `"video"` / `"model"` / `"font"` / `"data"`，也接受适配器自定义的字符串。内置名字只是可读性约定，引擎不按种类分支。
- `AssetLike.url`：通常是 URL，也可以是适配器自己的键。`AssetLike.kind`：种类，只作标注。`AssetLike.payload`：可选项，缺省 = 不带额外产物；带上是适配器私有数据，引擎只保证原样往返。
- `AssetSource.load`：返回 Promise。契约只约定「能按 URL 拿到一个 `AssetLike`」，不约定协议、编码、缓存策略，也不规定必须有一份清单。实现方可以是 `fetch`、文件系统、打包器内联表、第三方引擎的加载器。
- 缺省装配：不注入 `assets` = fail-fast，`assets.load` 直接报 `spec_violation`。
- `assets` 只在 `setup` 阶段可得，逐帧回调里没有这个口。
- 运行期 `spawn` 的异步 `setup` 在帧边界物化：它的加载在帧与帧之间完成，不从既有帧里挪用时间。
- `PointerState.x` / `PointerState.y`：归一化到 0..1，左上角为原点；`down` 表示当前是否按下。
- `PointerInputEvent.button`：缺省 `"primary"`，另有 `"secondary"` / `"auxiliary"`。
- `InputSnapshot.buttons`：按下顺序的只读数组；`InputSnapshot.keys`：只读集合；`InputSnapshot.lastEventAtMs`：最近生效事件的时间线毫秒，尚无生效事件时为 `null`。
- `InputSnapshot` 语义 = 该时刻已生效的全部事件的累积结果；纯只读数据，同一输入在任意时刻查询必得相等快照。
- `InputTrack.events`：按声明顺序排列，时刻不要求排序；实现负责归一化。
- `InputTrack.snapshotAt`：只读、无副作用；同一时刻多次查询得同一份快照。预览与导出注入同一份事件表即得同一串快照。
- 边界包含关系：`atMs` 等于查询时刻的事件已生效，大于查询时刻的不生效。
- 自动重复：`repeat` 为真的按键事件不改变按下集合。
- 非法事件表在构建期就报 `spec_violation` 并指出是第几条，不等渲染到那一帧才炸。
- 确定性前提：同场景加同事件表即得同帧序列；事件表是数据，不是对真实设备的采样。

## 相关

- 端口源码：`packages/contracts/src/asset/ports.ts`、`packages/contracts/src/asset/entities.ts`、`packages/contracts/src/input/ports.ts`、`packages/contracts/src/input/entities.ts`
- 入口选项：`packages/contracts/src/entry/ports.ts`（`assets`、`input`、`seed`）
- 相邻页：`docs/contracts/scene.md`、`docs/contracts/audio.md`、`docs/contracts/index.md`
