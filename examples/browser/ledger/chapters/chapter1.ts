/** 第 1 章（K01–K08）：从黑屏开始记账，版本一枚枚落下。 */
import type { SceneEnv } from "@lingfan-video/contracts";
import type { Painters } from "../frames/frame";
import { chapterBody } from "./body";

const CHAPTER = 0;

export function chapter1(
  head: boolean,
  painters: Painters,
  cycle = true,
): (env: SceneEnv) => void {
  return chapterBody(CHAPTER, head, painters, cycle);
}
