/**
 * @lingfan-video/infra：契约的默认适配器集（端口与适配器成对）。
 * 只依赖 @lingfan-video/contracts（能力只依赖契约，不知道 core 存在）。
 */
export { FrameSequenceExporter } from "./export/frame-sequence-exporter";
export { WebCodecsExporter } from "./export/webcodecs-exporter";
export type { WebCodecsExporterOptions } from "./export/webcodecs-exporter";
export { MemoryFrameSink } from "./capture/memory-sink";
