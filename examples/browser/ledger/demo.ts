/**
 * 透明产物演示片段：取全片开头几镜，只登记画面、不登记声音。
 *
 * 为什么不整片出：APNG 会把每一帧压好的扫描线留在内存里，整片六千多帧在
 * 1280×720 下是几百 MB 量级；透明 WebM 的 alpha 侧通道则是每帧多一路编码。
 * 演示只需要证明「透明帧能变成真实产物」，所以取一段就够，长度由所选片段自己求和。
 *
 * 也不登记声音：这一段是素材演示（叠到别的片子里用），带不带音轨与透明无关。
 */
import { start, type SceneInternal } from "@lingfan-video/core";
import type { SceneEnv } from "@lingfan-video/contracts";

import { scheduleShots } from "./chapters/shots";
import { FRAMES } from "./frames";
import type { Painters } from "./frames/frame";
import { C1 } from "./script/c1";

/** 演示片段取前几镜：头两镜已含「从全透明起手」与「叠在底图上」两种情形 */
const DEMO_SHOTS = 2;

/**
 * 装配透明产物演示片段。
 *
 * @param painters 画面层；不传则只求状态（单测用）
 * @returns 可直接推演的片段（窗口长度由所选片段求和，不另外写表）
 */
export function buildAlphaDemo(painters: Painters = {}): SceneInternal<void> {
  const shots = C1.slice(0, DEMO_SHOTS);
  const frames = FRAMES[0]!.slice(0, DEMO_SHOTS);
  const length = shots.reduce((sum, shot) => sum + shot.length, 0);
  const body = (env: SceneEnv): void => {
    scheduleShots(env, shots, frames, painters);
  };
  return start(length, body) as SceneInternal<void>;
}
