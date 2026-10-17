import type { Ms } from "../shared/units";
import type { AudioClipRef } from "./entities";

/** 音频挂载选项：at/volume/fadeIn/fadeOut/loop；音频不占帧窗池、不改 step 模型 */
export interface AudioOptions {
  at?: Ms;
  volume?: number;
  fadeIn?: Ms;
  fadeOut?: Ms;
  loop?: boolean;
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
 */
export interface AudioClock {
  renderTimeline(durationMs: Ms, fps: number): Promise<AudioSample[]>;
  decode(clip: AudioClipRef): Promise<DecodedAudio>;
}
