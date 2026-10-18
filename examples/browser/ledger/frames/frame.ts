/**
 * 一段的 fn 骨架：只读引擎给的这一刻，把这一帧的事实算出来。
 *
 * 三十一个镜头各自在自己的文件里交出 fn（`frames/c1`…`c3`），
 * 这里只放它们共用的那一件事：把静态内容与 `ctx` 合成一帧的 `FrameState`。
 */
import type { FrameState, StepContext } from "@lingfan-video/contracts";
import { FIELD_CYCLE_MS, readingAt, type Shot } from "../script";

export function shotFrame(
  shot: Shot,
  order: number,
  chapter: number,
  ctx: StepContext,
): FrameState & {
  shot: string;
  order: number;
  chapter: number;
  field: Shot["field"];
  mode: Shot["mode"];
  fps: Shot["fps"];
  t: number;
  /** 引擎算出的全片总长：二维层排版用它，不读剧本常量 */
  totalTime: number;
  /** 引擎给的帧序号：屏幕角上的 #号读它，不是自己数的 */
  frameIndex: number;
  local: number;
  duration: number;
  progress: number;
  phase: number;
  revealed: number;
  readings: readonly string[];
  verb: string;
  caption: string;
  code: string;
  date: string;
} {
  const duration = ctx.duration;
  const local = Math.max(0, Math.min(duration, ctx.localT));
  const readings = shot.readings ?? [];

  // 图形进度：按引擎给的全片时刻取模——切镜不重播，也不依赖任何时间表
  const phase = (ctx.t % FIELD_CYCLE_MS) / FIELD_CYCLE_MS;

  let revealed = 0;
  for (let index = 0; index < readings.length; index += 1)
    if (local >= readingAt(index)) revealed = index + 1;

  return {
    shot: shot.id,
    order,
    chapter,
    field: shot.field,
    mode: shot.mode,
    fps: shot.fps,
    t: ctx.t,
    totalTime: ctx.totalTime,
    frameIndex: ctx.frameIndex,
    local,
    duration,
    progress: duration > 0 ? local / duration : 0,
    phase,
    revealed,
    readings: readings.map((entry) =>
      entry.unit ? `${entry.value} ${entry.unit}` : entry.value,
    ),
    verb: shot.verb ?? "",
    caption: shot.caption ?? "",
    code: shot.code ?? "",
    date: shot.date ?? "",
  };
}

// 一帧的类型由 fn 推出来，不再手写第二份定义
export type LedgerState = ReturnType<typeof shotFrame>;

/** 画面层要能被 fn 直接画：fn 算出这一帧的状态，再把它交给层 */
export interface Painters {
  readonly field?: { paint(state: LedgerState): void };
  readonly type?: { paint(state: LedgerState): void };
}
