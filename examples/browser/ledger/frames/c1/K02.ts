/** K02 的 fn：这一段自己的画面事实，给一刻算一帧。 */
import type { StepContext } from "@lingfan-video/contracts";
import { SHOTS } from "../../script";
import { shotFrame } from "../frame";

export const K02 = (ctx: StepContext) => shotFrame(SHOTS[1]!, 1, 0, ctx);
