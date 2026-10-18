/**
 * 单一 DSP 内核的公共入口：流式混音器与整段渲染。
 *
 * - `StreamingMixer`：块处理内核，逐块渲染（预览端 AudioWorklet 与导出端共用同一实现）；
 * - `mixProgram`：一次性整段渲染，内部按块尺寸循环驱动内核（导出端与测试用）；
 * - `ProgramVoice` / `VoicePcm`：输入数据形状（声音声明 + 已解码 PCM）。
 * 采样率、声道数、时长与总线拓扑一律由调用方显式给出，内核不读全局设备状态。
 */
export { DEFAULT_BLOCK_FRAMES, StreamingMixer, mixProgram } from "./mixer";
export type { MixProgramInput, StreamingMixerOptions } from "./mixer";
export type { ProgramVoice, VoicePcm } from "./types";
