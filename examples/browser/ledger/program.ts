/**
 * 《刻度》的装配：三章串成一条链，章内逐段推演，章与章用 `cutTo` / `transitionTo` 接。
 *
 * 这里只做装配——时间、fps、层、声音的语义全在契约里：
 * - 每章只声明自己的窗口长度；总长是链算出来的，不是外部表格；
 * - 每章 body 起自己的 loop 周期，再逐段 step（采样密度由段自己声明）；
 * - fn 在 `frames/` 里一镜一个文件；画面在 `type/` 与 `field/` 里按 fn 的状态画；
 * - 层随段声明（`field:<镜号>` / `type:<镜号>`），宿主按 id 给面，段与段之间层连续。
 *
 * 单测可直接对 `SCENES[i]` 求值，也可只拿某一段的 fn 算它的帧，不必整片渲染。
 */
import { start, type SceneInternal } from "@lingfan-video/core";
import { chapter1 } from "./chapters/chapter1";
import { chapter2 } from "./chapters/chapter2";
import { chapter3 } from "./chapters/chapter3";
import { CHAPTER_LENGTHS, CHAPTER_OVERLAP_MS } from "./script";

export { readingAt } from "./script";
export { shotFrame, type LedgerState, type Painters } from "./frames/frame";

/** 一次装配的产物：三章各自的场景（可单测）+ 整条链（可推演） */
export interface LedgerProgram {
  readonly scenes: readonly SceneInternal<void>[];
  readonly picture: SceneInternal<void>;
}

/**
 * 装配整片。不给画面层时就只求状态（单测、音频编译够用）；
 * 给 `field` / `type` 时，fn 每帧算出的状态会同时画进这两层。
 */
export interface ProgramOptions {
  /** 每章自己的 loop 周期；关掉只留逐段 step（给帧数的解析断言用） */
  readonly cycle?: boolean;
}

export function buildProgram(
  painters: import("./frames/frame").Painters = {},
  options: ProgramOptions = {},
): LedgerProgram {
  const cycle = options.cycle ?? true;
  const scenes = [
    start(CHAPTER_LENGTHS[0]!, chapter1(true, painters, cycle)),
    start(CHAPTER_LENGTHS[1]!, chapter2(false, painters, cycle)),
    start(CHAPTER_LENGTHS[2]!, chapter3(false, painters, cycle)),
  ] as SceneInternal<void>[];

  // 链：第 1→2 章链式硬接，第 2→3 章重叠过场（重叠窗内两章各自推进）
  const head = scenes[0]!;
  head.cutTo(CHAPTER_LENGTHS[1]!, (_prev, env) => {
    chapter2(false, painters, cycle)(env);
    env.transitionTo(scenes[2]!, { overlapMs: CHAPTER_OVERLAP_MS[1] ?? 0 });
  });

  return { scenes, picture: head };
}

const idle = buildProgram();

/** 只求状态的装配：单测与音频编译用这条 */
export const SCENES = idle.scenes;
export const picture = idle.picture;

/** 预览与导出共用同一个入口 */
export const ledger = picture;
