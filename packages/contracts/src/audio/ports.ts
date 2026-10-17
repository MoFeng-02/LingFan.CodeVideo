import type { Ms } from "../shared/units";
import type { AudioClipRef } from "./entities";

/**
 * 时间映射锚点：时间线 atMs 处应播放源的 srcMs（均相对事件起点）。
 * 相邻锚点之间线性插值——斜率即播放速率，同时也是音高倍率（磁带式重采样）。
 * 末个锚点之后斜率延续（中途加速后不给恢复锚点 = 一直保持该速率）。
 * srcMs 取 "end" 表示「源播完处」，必须是末个锚点：用于把整段音频压缩/拉伸到
 * 恰好填满事件区间（自然收尾，无需知道源时长）。
 */
export interface WarpPoint {
  /** 事件内局部时间锚点（毫秒，严格递增；首个可为 0，其前隐式恒等） */
  atMs: Ms;
  /** 该时刻对应的源内位置（毫秒）或源尾标志 */
  srcMs: Ms | "end";
}

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
  /** 时间映射（变速/踩点/收尾）；省略 = 原速恒等映射 */
  warp?: readonly WarpPoint[];
}

/** 解码后的音频资产最小形态（声道布局由实现持有） */
export interface DecodedAudio {
  readonly clip: AudioClipRef;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: Ms;
}

/**
 * 交叉无关样本块（时间线区间 [atMs, atMs+ms) 的 PCM）。
 * 块序列须自 0 起、按时间顺序连续、无空隙：接帧端按顺序拼接即整轨。
 */
export interface AudioSample {
  data: Float32Array;
  atMs: Ms;
}

/**
 * 音频时钟契约：样本 = 时间线纯函数（同输入必同样本）。
 * 预览端装配实时实现；导出端装配确定性离线实现。
 * 输出只依赖时间线总时长、事件表与实现的采样率——与视频帧率无关：
 * 帧率只决定画面采样密度，任何改变音频字节的帧率依赖都会破坏该承诺。
 * events 为引擎收集的音频事件（挂载参数已编译）；实现据此铺轨混音。
 */
export interface AudioClock {
  /** 输出采样率（导出格式决定；接帧端按此声明交轨） */
  readonly sampleRate: number;
  /** 输出声道数（交错布局；接帧端按此声明交轨） */
  readonly channels: number;
  renderTimeline(
    durationMs: Ms,
    events: readonly AudioTimelineEvent[],
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
  /** 时间映射锚点（atMs 相对事件起点；省略 = 原速） */
  warp?: readonly WarpPoint[];
}
