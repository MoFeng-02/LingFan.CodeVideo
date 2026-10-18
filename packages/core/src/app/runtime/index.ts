/**
 * 运行时出口：引擎入口与其装配面。
 *
 * 这里只做转发——引擎实现按职责拆在 build（时间线构建）、frame-eval（逐帧求值）、
 * spawn（运行期链）、audio（声音与总线）几个文件里，外部只需要引擎类、
 * 装配参数、推演摘要与输入/错误工具。
 */
/** 结构化渲染错误工厂 */
export { makeRenderError } from "./error";
/** 时间线引擎（登记 → 编译 → 逐帧求值 → 交帧） */
export { TimelineEngine } from "./engine";
/** 引擎装配参数与推演摘要 */
export type { EngineOptions, RunSummary } from "./engine-types";
/** 空输入快照与输入轨道工厂 */
export { EMPTY_INPUT, createInputTrack } from "./input";
