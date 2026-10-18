/**
 * 拍网格（域层纯函数）：把「节拍」翻译成时间线毫秒。
 *
 * 为什么不做成契约概念：拍是作者写时间线时的换算，引擎只认毫秒；
 * 网格点在登记期一次性展开成毫秒数字，之后的时间语义与手写毫秒完全相同。
 */
import type { Ms } from "@lingfan-video/contracts";
import { violation } from "../spec-violation";

/**
 * 一拍毫秒数：`60000 / bpm`（120 BPM = 500ms/拍）。
 *
 * @param bpm 每分钟拍数（> 0 的有限数）
 * @returns 一拍时长（毫秒）
 * @throws spec_violation bpm 非正或非有限数时
 */
export function msPerBeat(bpm: number): Ms {
  if (!Number.isFinite(bpm) || bpm <= 0)
    throw violation(`bpm=${String(bpm)} 须为 > 0 的有限数`);
  return 60000 / bpm;
}

/** 拍网格的构造参数：拍速 + 细分 + 一个上界（点数或截止时刻二选一）。 */
export interface BeatGridOptions {
  /** 每分钟拍数（> 0） */
  readonly bpm: number;
  /** 细分：1 = 整拍（缺省），2 = 半拍，4 = 四分之一拍 */
  readonly subdivision?: number;
  /** 网格点数（与 untilMs 二选一） */
  readonly count?: number;
  /** 网格上界：只保留 < untilMs 的点（与 count 二选一） */
  readonly untilMs?: Ms;
  /** 首点在时间线上的时刻（毫秒，缺省 0） */
  readonly from?: Ms;
  /** 首点相对拍位的偏移（毫秒，缺省 0；做后置拍/切分用） */
  readonly offsetMs?: Ms;
}

/**
 * 拍网格点（毫秒，严格递增）：`from + offsetMs + i * (一拍/细分)`。
 *
 * `count` 与 `untilMs` 必须给且只给一个——没有上界的网格会无限长。
 * 给 `untilMs` 时只保留严格小于它的点；`offsetMs` 用于后置拍/切分。
 *
 * @param options 拍网格参数：bpm、subdivision、count/untilMs、from、offsetMs
 * @returns 网格时刻（毫秒，严格递增）
 * @throws spec_violation 参数非法或上界缺失/二义时
 */
export function beatGrid(options: BeatGridOptions): readonly Ms[] {
  const beat = msPerBeat(options.bpm);
  const subdivision = options.subdivision ?? 1;
  if (!Number.isFinite(subdivision) || subdivision <= 0)
    throw violation(
      `beatGrid.subdivision=${String(subdivision)} 须为 > 0 的有限数`,
    );
  const from = options.from ?? 0;
  if (!Number.isFinite(from) || from < 0)
    throw violation(`beatGrid.from=${String(from)} 须为 ≥0 的有限毫秒`);
  const offset = options.offsetMs ?? 0;
  if (!Number.isFinite(offset) || offset < 0)
    throw violation(`beatGrid.offsetMs=${String(offset)} 须为 ≥0 的有限毫秒`);
  const step = beat / subdivision;
  const origin = from + offset;
  if (options.count !== undefined) {
    if (options.untilMs !== undefined)
      throw violation("beatGrid 的 count 与 untilMs 只能给一个");
    const count = options.count;
    if (!Number.isInteger(count) || count < 1)
      throw violation(`beatGrid.count=${String(count)} 须为 ≥1 的整数`);
    return Array.from({ length: count }, (_, i) => origin + i * step);
  }
  if (options.untilMs === undefined)
    throw violation("beatGrid 需要 count 或 untilMs 之一作为上界");
  const until = options.untilMs;
  if (!Number.isFinite(until) || until < 0)
    throw violation(`beatGrid.untilMs=${String(until)} 须为 ≥0 的有限毫秒`);
  const out: Ms[] = [];
  for (let t = origin; t < until; t += step) out.push(t);
  return out;
}
