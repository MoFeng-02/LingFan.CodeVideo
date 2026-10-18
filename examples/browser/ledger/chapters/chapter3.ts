/** 第 3 章（K21–K31）：看得见、想要什么就做什么，最后落版。 */
import type { SceneEnv } from "@lingfan-video/contracts";
import type { Painters } from "../frames/frame";
import { chapterBody } from "./body";

const CHAPTER = 2;

export function chapter3(
  head: boolean,
  painters: Painters,
  cycle = true,
): (env: SceneEnv) => void {
  return chapterBody(CHAPTER, head, painters, cycle);
}
