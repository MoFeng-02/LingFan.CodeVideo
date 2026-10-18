/**
 * 过场遮盖进度（域层纯函数）：把时间线上的绝对时刻翻译成 0..1 的遮盖量。
 *
 * 为什么必须是绝对时间：遮盖用来在切点前后各画一半。出幕按 `alpha` 遮住画面、
 * 入幕按 `1 - alpha` 揭开，两段都读同一个绝对时刻，切点两侧才严丝合缝；
 * 用各自的 `localT / 窗外时长` 会让入幕在切点把遮盖量重新从 0 起算，看上去闪一下。
 *
 * 之所以放在域层而不是契约：引擎不认识「遮盖」，它只知道画什么由宿主决定；
 * 这里给的只是一条作者可复用的折线，不引入新的语义。
 */
import type { Ms } from "@lingfan-video/contracts";
import { violation } from "../spec-violation";

/** `fromMs` 之前为 0，`fromMs + durationMs` 之后为 1，中间线性 */
export function coverProgress(atMs: Ms, fromMs: Ms, durationMs: Ms): number {
  if (
    !Number.isFinite(atMs) ||
    !Number.isFinite(fromMs) ||
    !Number.isFinite(durationMs)
  )
    throw violation(
      `coverProgress(${String(atMs)}, ${String(fromMs)}, ${String(durationMs)}) 要求三个参数都是有限数`,
    );
  if (durationMs <= 0) return atMs >= fromMs ? 1 : 0;
  const raw = (atMs - fromMs) / durationMs;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}
