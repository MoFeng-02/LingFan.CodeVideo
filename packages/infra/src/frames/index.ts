/**
 * 帧合成模块公共入口：合成器接缝、合成宿主、层计划与载体工具。
 *
 * 数据流是单向的：剧本声明层 → 宿主按 id 配对渲染面 → 每帧挑出可见层
 * （`planComposite`）→ 各层画自己的面 → 合成器把底图与这些面叠成一张
 * `FrameHandle`，交给导出端。这里不碰时间线，只吃「帧号 + 毫秒时间戳」。
 *
 * 注意：合成器是可替换的接缝，`createCanvas2dCompositor` 只是缺省实现；
 * 其余后端放在 `adapters/` 子目录，刻意不经这里导出，避免把所有依赖拖进来。
 */
export * from "./types";
export { isLayerActive, planComposite } from "./compose-plan";
export {
  createCompositeHost,
  type CompositeHost,
  type CompositeHostOptions,
} from "./composite-host";
export { createCanvas2dCompositor } from "./canvas2d-compositor";
export { isFrameHandle, requireFrameHandle } from "./carrier";
export { createReadbackHost, readBackHandle, toBitmap } from "./readback-host";
