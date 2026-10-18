/**
 * 音频程序装配：时间线登记完成后，交给 AudioOutput 的那一份声音描述。
 *
 * 预览（WebAudioOutput.begin 预排）与音频程序编译（页面加载期预热）都从这里取程序，
 * 因此「预热时合成的样本」与「播放时投递的程序」是同一份数据，不存在两条编译路径。
 */
import type { AudioProgram } from "@lingfan-video/contracts";
import { buildAudioGraph } from "./audio-graph";
import type { TimelineState } from "./engine-types";

/**
 * 时间线状态的音频程序：总时长 + 声音记录 + 总线图（三者同一时刻产出）。
 *
 * `voices` 直接引用运行期的声音记录表：登记期声明已在其中，运行期发射再往后追加。
 *
 * @param state 已完成时间线构建的引擎状态
 * @returns 交给 AudioOutput 的程序
 */
export function buildAudioProgram(state: TimelineState): AudioProgram {
  return {
    durationMs: state.timelineEnd,
    voices: state.audioVoices,
    graph: buildAudioGraph(state, "timeline"),
  };
}
