/**
 * AudioWorklet 全局环境的最小声明。
 *
 * lib.dom 只到 `AudioWorklet` / `AudioWorkletNode`，处理器一侧的 `AudioWorkletProcessor`、
 * `registerProcessor` 与 `sampleRate` / `currentTime` / `currentFrame` 需要在此声明。
 * 这些标识符只在音频线程里存在，主线程代码不要引用。
 */
declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: readonly Float32Array[][],
    outputs: Float32Array[][],
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;
