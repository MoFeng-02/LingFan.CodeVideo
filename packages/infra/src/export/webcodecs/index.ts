/**
 * WebCodecs 导出适配器入口：只转发类与参数类型。
 *
 * 内部按「时序编排 / 视频轨 / 音频轨 / 错误接力」拆分；外部只从这里取。
 */
export { WebCodecsExporter } from "./exporter";
export type { WebCodecsExporterOptions } from "./types";
