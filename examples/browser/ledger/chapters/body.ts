/**
 * 一章的登记：起本章自己的周期，再逐段把「窗口 + 采样密度 + 响动 + fn」交给引擎。
 *
 * fn 只读引擎给的那一刻；画面归层：fn 每帧算出的状态同时交给 `field` 与 `type`。
 * `loop` 是后台重复，不推进游标、不占帧窗池。
 */
import type { SceneEnv } from "@lingfan-video/contracts";
import { buildBuses, scheduleChapter } from "../audio";
import { FRAMES } from "../frames";
import type { Painters } from "../frames/frame";
import { BAR_MS, CHAPTERS, CHAPTER_LENGTHS } from "../script";
import { scheduleShots } from "./shots";

export function chapterBody(
  chapterIndex: number,
  head: boolean,
  painters: Painters,
  cycle: boolean,
): (env: SceneEnv) => void {
  const chapter = CHAPTERS[chapterIndex]!;
  const length = CHAPTER_LENGTHS[chapterIndex]!;
  const frames = FRAMES[chapterIndex]!;

  return (env) => {
    if (head) buildBuses(env);

    env.par([
      // 声音一支：只登记音频，不碰画面
      (b) => scheduleChapter(b, chapterIndex),
      // 片段自己的周期：后台重复 120 BPM 的一小节（不推游标；关掉时只剩逐段 step）
      ...(cycle
        ? [
            (b: SceneEnv) =>
              b.loop({
                ms: BAR_MS,
                times: Math.max(1, Math.round(length / BAR_MS)),
                fn: () => undefined,
              }),
          ]
        : []),
      // 推演一支：逐段 step，本段窗口与采样密度都由这一段自己声明
      (b) => scheduleShots(b, chapter, frames, painters),
    ]);
  };
}
