/**
 * 《刻度》剧本的入口：三批镜头拼成 SHOTS，章、总长、印章、落版都由它们派生。
 *
 * 时间不是外部表格：每段只写自己的**帧窗池长度**，每章是链上的一段，
 * 章与章用 cutTo / transitionTo 接；`SHOT_START` 只是给版面摆印章的派生数据。
 *
 * 内容同时走四条线，但每条只在一镜里落一次：
 * 版本（代号与日期）、技术（它多会一样什么）、影响（世界跟着动了什么）、
 * 人（普通人能不能用上）。所以一镜要么在报版本，要么在报影响，不混着说。
 *
 * 采样密度按镜头里"有多少东西在动"给：静场 30 / 推移 60 / 生长 90 / 粒子与快切 120。
 * 每段长度都是 100ms 的整数倍——100ms 同时是 30/60/90/120 的整数分之一。
 */
import type { Ms } from "@lingfan-video/contracts";
import { C1 } from "./c1";
import { C2 } from "./c2";
import { C3 } from "./c3";
import type { Shot } from "./types";

export * from "./types";

/** 三十一个片段，按内容分成三章 */
export const SHOTS: readonly Shot[] = [...C1, ...C2, ...C3];

/** 三章：每章是一个完整的片段周期 */
export const CHAPTERS: readonly (readonly Shot[])[] = [C1, C2, C3];

/** 章间重叠（毫秒）：第 1→2 章硬切，第 2→3 章重叠过场 */
export const CHAPTER_OVERLAP_MS: readonly Ms[] = [0, 400];

/** 每章自己的帧窗池长度（章内各段之和） */
export const CHAPTER_LENGTHS: readonly Ms[] = CHAPTERS.map((chapter) =>
  chapter.reduce((sum, shot) => sum + shot.length, 0),
);

/** 成片总长：各章之和减去重叠（派生值，不是外部写死的时间表） */
export const TOTAL: Ms =
  CHAPTER_LENGTHS.reduce((sum, ms) => sum + ms, 0) -
  CHAPTER_OVERLAP_MS.reduce((sum, ms) => sum + ms, 0);

/** 十二枚版本印章：按出现顺序排在刻度尺上（只带代号与日期）。 */
export interface Stamp {
  readonly code: string;
  readonly date: string;
  readonly shot: string;
}

export const STAMPS: readonly Stamp[] = SHOTS.flatMap((shot) =>
  typeof shot.code === "string"
    ? [{ code: shot.code, date: shot.date ?? "", shot: shot.id }]
    : [],
);

/** 三维信号场的图形循环周期：图形进度按引擎给的 t 取模，不认全片表 */
export const FIELD_CYCLE_MS: Ms = 4_000;
/** 读数逐项上屏的段内偏移：fn 与二维层共用这一份节奏 */
export const READING_IN_MS: Ms = 780;
export const READING_STEP_MS: Ms = 900;

/** 第 i 枚读数上屏的段内时刻 */
export function readingAt(index: number): Ms {
  return READING_IN_MS + index * READING_STEP_MS;
}

/**
 * 落版：只写「这一段窗口里的第几毫秒」。
 * 段首时刻由链算，脚本不预设全片总长。
 */
export const END_CARD = {
  code: "V4.1-Flash-1017",
  date: "2026.10.17",
  line: "记录到此。下一次读数，由你填。",
  credits: ["DeepSeek × LingFan Code Video", "DeepSeek Harness"],
  /** 这一段自己的帧窗池长度 */
  window: 4_800,
  /** 段内偏移（毫秒）——由剧本给的是这个，不是绝对时间 */
  at: {
    mark: 800,
    code: 1_500,
    date: 2_000,
    line: 2_600,
    credits: [3_200, 3_500],
  },
  /** 段内偏移：从这里开始淡出 */
  out: 4_100,
} as const;

/** 120 BPM：一拍 500ms，一小节 2000ms */
export const BEAT_MS = 500;
export const BAR_MS = 2_000;
