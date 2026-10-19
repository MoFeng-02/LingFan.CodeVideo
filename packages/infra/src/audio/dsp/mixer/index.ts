/**
 * 混音内核入口：流式混音器、整段渲染与公共类型。
 *
 * 外部只从这里取混音能力；内部按「参数求值 / 流式内核 / 整段渲染」拆分，改动互不影响。
 */
export { DEFAULT_BLOCK_FRAMES } from "./types";
export { StreamingMixer } from "./streaming-mixer";
export { mixProgram } from "./mix-program";
export type { MixProgramInput, StreamingMixerOptions } from "./types";
