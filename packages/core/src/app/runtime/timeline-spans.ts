/**
 * 段窗口判定与重叠窗换算：回答「某时刻哪些段在活跃」。
 *
 * transitionTo 可以声明 overlapMs 让相邻两段共享一段窗口；本模块只处理时间区间，
 * 绘制顺序（谁压在谁上面）由调用方按链上顺序决定。
 */
import type { Ms } from "@lingfan-video/contracts";
import type { ChainSpan, SpawnChain } from "./engine-types";
import { makeRenderError } from "./error";

/**
 * 重叠窗前移量：上一段声明了 overlapMs 时，本段起点要提前这么多
 * （窗口内两段同时在场；校验放在构建期、第一帧之前）。
 *
 * @param pendingOverlap 上一段声明的重叠窗（毫秒，0 = 无重叠）
 * @param length 本段内容长度（毫秒，即本段实际占用的窗口）
 * @param sceneId 本段场景 id（仅用于报错定位）
 * @param cursor 本段起点（全局毫秒，仅用于报错定位）
 * @returns 本段起点应提前的毫秒数（无重叠时为 0）
 * @throws RenderError（kind = spec_violation）重叠窗不小于本段长度时——那会吞掉整段
 */
export function overlapOffset(
  pendingOverlap: Ms,
  length: Ms,
  sceneId: string,
  cursor: Ms,
): Ms {
  if (pendingOverlap <= 0) return 0;
  if (pendingOverlap >= length)
    throw makeRenderError(
      "spec_violation",
      sceneId,
      cursor,
      `重叠窗 ${pendingOverlap}ms 不小于本段长度 ${length}ms（下一段会吞掉整段）`,
    );
  return pendingOverlap;
}

/**
 * span 活跃判定：t 落在 [start,end) 内（重叠窗内可能有多段同时活跃）。
 *
 * @param spans 按链上顺序排列的段窗口
 * @param t 时间线全局时刻（毫秒）
 * @returns 第一个活跃段；没有则 `undefined`
 */
export function findSpan(spans: ChainSpan[], t: Ms): ChainSpan | undefined {
  return spans.find((s) => t >= s.start && t < s.end);
}

/**
 * 全部活跃 span，按链上顺序返回（重叠窗内两段都在，后者后绘制）。
 *
 * @param spans 按链上顺序排列的段窗口
 * @param t 时间线全局时刻（毫秒）
 * @returns 活跃段列表（升序；空数组 = 此刻没有段活跃）
 */
export function findSpans(spans: ChainSpan[], t: Ms): ChainSpan[] {
  const active: ChainSpan[] = [];
  for (const s of spans) if (t >= s.start && t < s.end) active.push(s);
  return active;
}

/**
 * forever 链的活跃 span：正常窗口，或内容播完后按内容时长回卷（重叠窗同样成立）。
 *
 * @param chain spawn 链（`spans` 按链上顺序排列）
 * @param t 时间线全局时刻（毫秒）
 * @returns 活跃段列表；内容尚未编译（无 span）或内容长度非正时为空
 */
export function findSpansLooping(chain: SpawnChain, t: Ms): ChainSpan[] {
  const active = findSpans(chain.spans, t);
  if (active.length > 0) return active;
  const last = chain.spans[chain.spans.length - 1];
  if (!last) return [];
  const contentLen = last.end - chain.start;
  if (!(contentLen > 0)) return [];
  const local = (t - chain.start) % contentLen;
  return findSpans(chain.spans, chain.start + local);
}

/**
 * forever 链 span 查找：t 超出内容总长后按链内容时长取模回卷（循环重放）。
 *
 * @param chain spawn 链
 * @param t 时间线全局时刻（毫秒）
 * @returns 回卷后的活跃段；链无内容（或内容长度非正）时 `undefined`
 */
export function findSpanLooping(
  chain: SpawnChain,
  t: Ms,
): ChainSpan | undefined {
  const span = findSpan(chain.spans, t);
  if (span) return span;
  const last = chain.spans[chain.spans.length - 1];
  if (!last) return undefined;
  const contentLen = last.end - chain.start;
  if (!(contentLen > 0)) return undefined;
  const local = (t - chain.start) % contentLen;
  return findSpan(chain.spans, chain.start + local);
}
