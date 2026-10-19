/**
 * TimeProbe 演示场景：验证取样专用的最小链。
 *
 * 帧函数只发布状态、不画任何像素——验证本来就不依赖画面：compute 取样走
 * headless 1×1 引擎，同一份剧本既能渲染也能只取状态表。
 */
import { start } from "@lingfan-video/core";

/** 取样窗口（毫秒）：TimeProbe 的滑杆与表格按它定界 */
export const LENS_MS = 800;

/** 单步 800ms：每个 60fps 网格点发布 wave（-1..1 正弦）与 beat（200ms 一拍） */
export const lensScene = start(LENS_MS, (env) => {
  env.step(LENS_MS, (ctx) => ({
    wave: +Math.sin((ctx.localT / LENS_MS) * Math.PI * 2).toFixed(3),
    beat: Math.floor(ctx.localT / 200) + 1,
  }));
});
