import type { Ms } from "@lingfan-video/contracts";
import type { ChainSpan, SpawnChain } from "./engine-types";
import { makeRenderError } from "./error";

/**
 * 重叠窗前移量：上一段声明了 overlapMs 时，本段起点要提前这么多
 * （窗口内两段同时在场；校验放在构建期、第一帧之前）。
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

/** span 活跃判定：t 落在 [start,end) 内（重叠窗内可能有多段同时活跃） */
export function findSpan(spans: ChainSpan[], t: Ms): ChainSpan | undefined {
  return spans.find((s) => t >= s.start && t < s.end);
}

/** 全部活跃 span，按链上顺序返回（重叠窗内两段都在，后者后绘制） */
export function findSpans(spans: ChainSpan[], t: Ms): ChainSpan[] {
  const active: ChainSpan[] = [];
  for (const s of spans) if (t >= s.start && t < s.end) active.push(s);
  return active;
}

/** forever 链的活跃 span：正常窗口，或内容播完后按内容时长回卷（重叠窗同样成立） */
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

/** forever 链 span 查找：t 超出内容总长后按链内容时长取模回卷（循环重放） */
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
