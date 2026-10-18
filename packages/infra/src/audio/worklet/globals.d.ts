/**
 * AudioWorklet 全局环境的最小声明。
 *
 * lib.dom 只到 `AudioWorklet` / `AudioWorkletNode`，处理器一侧的 `AudioWorkletProcessor`、
 * `registerProcessor` 与 `sampleRate` / `currentTime` / `currentFrame` 需要在此声明。
 * 这些标识符只在音频线程里存在，主线程代码不要引用。
 */

/** 音频线程的采样率（Hz，设备参数；渲染回调内恒定） */
declare const sampleRate: number;
/** 音频线程时钟（秒，从 AudioContext 启动起算；每次渲染回调推进一个块） */
declare const currentTime: number;
/** 当前渲染块的起始帧号（帧，按 sampleRate 计；用于把时间换算成帧） */
declare const currentFrame: number;

/**
 * 音频线程里处理器实例的基类。
 *
 * 由 `registerProcessor` 注册的子类实例化；`port` 是它与主线程之间唯一的通信通道
 * （只能传结构化克隆数据，不能传函数/类实例等不可克隆对象）。
 */
declare class AudioWorkletProcessor {
  /** 与主线程通信的端口（主线程侧是 node.port，两侧共享同一对端口） */
  readonly port: MessagePort;

  constructor();

  /**
   * 渲染回调：每个块调用一次，返回 false 表示处理器可以停止。
   *
   * @param inputs 输入声道数据（本处理器声明 0 个输入，故为空数组）
   * @param outputs 输出声道数据：`outputs[0][channel][frame]`，长度由 audioWorkletNode 的 outputChannelCount 决定
   * @returns 是否继续接收渲染回调（false = 停止）
   */
  process(
    inputs: readonly Float32Array[][],
    outputs: Float32Array[][],
  ): boolean;
}

/**
 * 注册音频线程处理器。
 *
 * @param name 处理器名（主线程构造 AudioWorkletNode 时用同一名字）
 * @param processor 处理器类（继承 AudioWorkletProcessor，无参构造）
 */
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;
