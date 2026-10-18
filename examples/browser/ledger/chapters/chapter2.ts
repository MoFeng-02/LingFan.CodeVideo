/** 第 2 章（K09–K20）：会写、会长文、会分档。 */
import type { SceneEnv } from "@lingfan-video/contracts";
import type { Painters } from "../frames/frame";
import { chapterBody } from "./body";

const CHAPTER = 1;

export function chapter2(
  head: boolean,
  painters: Painters,
  cycle = true,
): (env: SceneEnv) => void {
  return chapterBody(CHAPTER, head, painters, cycle);
}
