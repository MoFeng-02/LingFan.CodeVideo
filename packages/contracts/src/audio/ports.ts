import type { Ms } from "../shared/units";
import type { AudioClipRef } from "./entities";

/**
 * 音频挂载选项；音频不占帧窗池、不改 step 模型。
 * 多实例并存：同 clip 可多次 audio()，各自独立（事件模型，非总线独占）。
 */
export interface AudioOptions {
  at?: Ms;
  volume?: number;
  fadeIn?: Ms;
  fadeOut?: Ms;
  loop?: boolean;
  /** 目标声道数（缺省跟随源：源 1 声道出 1，源 2 声道出 2；导出统一到导出布局） */
  channels?: number;
  /** 立体声摆位 -1（左）~ 1（右），仅目标为立体声时生效；缺省居中 */
  pan?: number;
}

/** 解码后的音频资产最小形态（声道布局由实现持有） */
export interface DecodedAudio {
  readonly clip: AudioClipRef;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: Ms;
}

/** 交叉无关样本块（时间线区间 [atMs, atMs+ms) 的 PCM） */
export interface AudioSample {
  data: Float32Array;
  atMs: Ms;
}

/**
 * 音频时钟契约：样本 = 时间线纯函数（同输入必同样本）。
 * 预览端装配实时实现；导出端装配确定性离线实现。
 * events 为引擎收集的音频事件（挂载参数已编译）；实现据此铺轨混音。
 */
export interface AudioClock {
  renderTimeline(
    durationMs: Ms,
    fps: number,
    events: AudioTimelineEvent[],
  ): Promise<AudioSample[]>;
  decode(clip: AudioClipRef): Promise<DecodedAudio>;
}

/** 音频事件（引擎收集形态的契约面：实现不依赖 core 类型） */
export interface AudioTimelineEvent {
  clipUrl: string;
  globalAtMs: Ms;
  volume: number;
  fadeIn?: Ms;
  fadeOut?: Ms;
  loop: boolean;
  channels?: number;
  pan: number;
}
