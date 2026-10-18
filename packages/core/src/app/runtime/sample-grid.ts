/**
 * 采样网格：把时间线上的单元窗口展开成帧时刻（毫秒）的并集。
 * 语义层单位是毫秒，fps 只是采样密度；空窗不产帧。
 */
import type { Ms } from "@lingfan-video/contracts";
import type { CompiledUnit } from "../../domain/simulation/types";
import type { ChainSpan, EvalDeps, TimelineState } from "./engine-types";

/**
 * 采样网格：各活跃单元在自己 fps 网格上的采样点并集。
 * - 单元 fps 网格：第 n 点 = windowStart + n×(1000/fps)，取整微秒去重
 * - hold 单元窗外冻结不加点（末点由窗口内网格覆盖）
 * - 空窗（无任何单元）不产帧——语义层单位是毫秒，fps 只是采样密度
 */
export function buildSampleGrid(state: TimelineState): Ms[] {
  const seen = new Set<number>(); // 微秒整数
  const points: number[] = [];
  const addUnit = (u: CompiledUnit, spanStart: Ms, spanEnd: Ms): void => {
    const s = spanStart + u.windowStart;
    const e = Math.min(spanStart + u.windowEnd, spanEnd);
    for (let i = 0; ; i++) {
      const tUs = Math.round((s + (i * 1000) / u.fps) * 1000);
      if (tUs >= Math.round(e * 1000) || tUs < Math.round(s * 1000)) break;
      if (!seen.has(tUs)) {
        seen.add(tUs);
        points.push(tUs);
      }
    }
  };

  const walkSpans = (spans: EvalDeps["state"]["spans"]): void => {
    for (const span of spans) {
      for (const u of span.seg.units) {
        // wait 回调单元不贡献采样点（自身不产帧）
        if (u.onUpdate) continue;
        if (u.loop && u.loop.iterationMs === undefined) {
          // 未给 ms：自管节奏——采样点沿基础帧率推进（自管单元没有固定网格）
          const s = span.start + u.windowStart;
          const e = Math.min(span.start + u.windowEnd, span.end);
          for (let tUs = Math.round(s * 1000); tUs < Math.round(e * 1000);) {
            if (!seen.has(tUs)) {
              seen.add(tUs);
              points.push(tUs);
            }
            tUs += Math.round(1_000_000 / state.opts.fps);
          }
        } else {
          addUnit(u, span.start, span.end);
        }
      }
    }
  };

  for (const c of state.spawnChains) {
    if (c.spans.length === 0) continue; // 待物化的链壳：异步 setup 未完成，还没有内容
    if (!c.killed) walkSpans(c.spans);
    // forever 链循环重放：内容播完后的尾段沿链网格（第一圈相位）补采样点
    if (!c.killed && c.end !== Infinity) {
      const contentLen = c.spans[c.spans.length - 1]!.end - c.start;
      if (contentLen > 0 && c.end - c.start > contentLen) {
        const loops = Math.ceil((c.end - c.start) / contentLen);
        const original = c.spans;
        for (let k = 1; k < loops; k++)
          for (const span of original) {
            const shifted: ChainSpan = {
              scene: span.scene,
              seg: span.seg,
              start: span.start + k * contentLen,
              end: span.end + k * contentLen,
            };
            for (const u of span.seg.units) {
              if (u.onUpdate) continue; // wait 回调单元不贡献采样点
              if (u.loop && u.loop.iterationMs === undefined) continue; // 未给 ms：循环圈内沿基础网格
              addUnit(u, shifted.start, shifted.end);
            }
          }
      }
    }
  }
  walkSpans(state.spans);
  points.sort((a, b) => a - b);
  return points.map((us) => us / 1000);
}

/** 网格里严格晚于 at 的第一个采样点（异步 setup 的链从这里整点开始） */
export function firstAfter(grid: readonly Ms[], at: Ms): Ms | undefined {
  let lo = 0;
  let hi = grid.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((grid[mid] ?? 0) <= at) lo = mid + 1;
    else hi = mid;
  }
  return grid[lo];
}
