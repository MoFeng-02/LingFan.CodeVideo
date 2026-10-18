/**
 * 音频组合子（域层纯函数）：把「写错的音频参数」挡在构造处。
 *
 * 每个组合子返回不可变强类型值并在构造期校验——DSL 里不再出现裸数字袋：
 * 单位混淆（秒/毫秒）、相邻概念混用（音量 vs 增益、循环 vs 时长）都会当场报错。
 * 组合子只造值、不加载素材；非法输入统一抛 `spec_violation`。静态校验（validate）
 * 会复查同一批判据，因此手写字面量绕过组合子也能被报出来。
 */
import type {
  AudioClip,
  AudioGain,
  AudioLoop,
  AudioPan,
  AudioOptions,
  AudioRate,
  AudioVoice,
  Envelope,
  EnvelopePoint,
  GainLike,
  Ms,
  WarpPoint,
} from "@lingfan-video/contracts";
import { toLinearGain } from "./gain-units";
import { violation } from "../spec-violation";

function isMs(v: unknown): v is Ms {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * 造一个音频片段引用：只记录地址，不加载素材。
 *
 * @param url 素材地址（非空字符串）：应指向 setup 阶段预解码的资产
 * @returns 带 brand 的片段对象（可再交给 audio/bgm 组合子）
 * @throws spec_violation 地址为空串或不是字符串时
 */
export function clip(url: string): AudioClip {
  if (typeof url !== "string" || url.length === 0)
    throw violation(`clip(url) 须为非空字符串（收到 ${String(url)}）`);
  return { url, kind: "audio" } as AudioClip;
}

/**
 * 造增益选项：值可以是线性幅度或 `{ db }`，淡入淡出在时间线毫秒域。
 *
 * @param value 增益记法：线性幅度（≥0 的有限数）或 `{ db: number }`（有限数）
 * @param env 可选附着参数：fadeIn/fadeOut（毫秒，≥0 有限）与整段包络
 * @returns 增益选项（值已折算成线性幅度，未知字段不带）
 * @throws spec_violation 记法非法或 fade 不是 ≥0 的有限毫秒时
 */
export function gain(
  value: GainLike,
  env?: {
    readonly fadeIn?: Ms;
    readonly fadeOut?: Ms;
    readonly envelope?: Envelope;
  },
): AudioGain {
  const linear = toLinearGain(value, "gain");
  const fadeIn = env?.fadeIn;
  const fadeOut = env?.fadeOut;
  if (fadeIn !== undefined && !isMs(fadeIn))
    throw violation(`gain.fadeIn=${String(fadeIn)} 须为 ≥0 的有限毫秒`);
  if (fadeOut !== undefined && !isMs(fadeOut))
    throw violation(`gain.fadeOut=${String(fadeOut)} 须为 ≥0 的有限毫秒`);
  return {
    value: linear,
    ...(fadeIn === undefined ? {} : { fadeIn }),
    ...(fadeOut === undefined ? {} : { fadeOut }),
    ...(env?.envelope ? { envelope: env.envelope } : {}),
  };
}

const envelopePoints = (
  points: ReadonlyArray<EnvelopePoint>,
): readonly EnvelopePoint[] => {
  if (points.length === 0) throw violation("envelope 至少需要一个折点");
  for (const p of points) {
    if (!Number.isFinite(p.atMs) || p.atMs < 0)
      throw violation(`envelope 折点时间 ${String(p.atMs)} 须为 ≥0 的有限毫秒`);
    if (!Number.isFinite(p.value) || p.value < 0)
      throw violation(`envelope 折点值 ${String(p.value)} 须为 ≥0 的有限数`);
  }
  return points.map((p) => ({ ...p }));
};

/**
 * 线性包络：局部 0 → from，局部 ms → to，其后保持 to。
 *
 * `ramp(0, 1, 300)` = 300ms 淡入到满；`ramp(1, 0, 300)` = 300ms 降到静音。
 *
 * @param from 局部 0 处的值（≥0 的有限数）
 * @param to 局部 ms 处的值（≥0 的有限数；ms 之后保持它）
 * @param ms 斜坡时长（毫秒，≥0 有限）
 * @returns 两点线性包络
 * @throws spec_violation 值或时长非法时
 */
export function ramp(from: number, to: number, ms: Ms): Envelope {
  return {
    points: envelopePoints([
      { atMs: 0, value: from },
      { atMs: ms, value: to },
    ]),
  };
}

/**
 * 分段线性包络：折点按局部毫秒严格递增，首个折点之前取首值。
 *
 * @param points 折点序列，每项为 `[局部毫秒, 值]`（时间与值都须为 ≥0 的有限数）
 * @returns 分段线性包络（折点被拷贝，外部再改数组不影响结果）
 * @throws spec_violation 空表、时间非法或时间未严格递增时
 */
export function curve(
  ...points: ReadonlyArray<readonly [Ms, number]>
): Envelope {
  if (points.length === 0) throw violation("curve() 至少需要一个折点");
  let prev = -Infinity;
  const out: EnvelopePoint[] = [];
  for (const [atMs, value] of points) {
    if (!Number.isFinite(atMs) || atMs < 0)
      throw violation(`curve 折点时间 ${String(atMs)} 须为 ≥0 的有限毫秒`);
    if (atMs <= prev)
      throw violation(`curve 折点时间 ${atMs} 未严格递增（前一点 ${prev}）`);
    prev = atMs;
    out.push({ atMs, value });
  }
  return { points: envelopePoints(out) };
}

/**
 * 淡入糖：局部 0 → 1，ms 处满（等价 `ramp(0, 1, ms)`）。
 *
 * @param ms 淡入时长（毫秒，≥0 有限）
 * @returns 两点线性包络
 * @throws spec_violation 时长非法时
 */
export function fadeIn(ms: Ms): Envelope {
  return ramp(0, 1, ms);
}

/**
 * 淡出：终点前 ms 开始从 1 降到 0，与声音实际终点对齐。
 *
 * 折点用「距终点」标记，因此包络不需要预先知道时长（终点由源播完/stop/终界决定）。
 *
 * @param ms 淡出时长（毫秒，≥0 有限）
 * @returns 相对终点的两点线性包络
 * @throws spec_violation 时长非法时
 */
export function fadeOut(ms: Ms): Envelope {
  return {
    points: envelopePoints([
      { atMs: ms, value: 1, fromEnd: true },
      { atMs: 0, value: 0, fromEnd: true },
    ]),
  };
}

/**
 * 立体声摆位：-1（全左）~ 1（全右），0 为居中。
 *
 * @param value 摆位值（-1 到 1 之间的有限数）
 * @returns 摆位选项
 * @throws spec_violation 越界或非有限数时
 */
export function pan(value: number): AudioPan {
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw violation(`pan(${value}) 须在 -1 ~ 1 之间`);
  return { value };
}

/**
 * 循环：省略时长 = 铺到总时间线尾（终界仍是时间线）。
 *
 * @param untilMs 循环终点（毫秒，≥0 有限）；省略 = 一直铺到时间线尾
 * @returns 循环选项（省略时为空对象）
 * @throws spec_violation 终点非法时
 */
export function loop(untilMs?: Ms): AudioLoop {
  if (untilMs !== undefined && !isMs(untilMs))
    throw violation(`loop(${String(untilMs)}) 须为 ≥0 的有限毫秒`);
  return untilMs === undefined ? {} : { untilMs };
}

/**
 * 恒速变速：value = 播放速率 = 音高倍率（须 > 0；禁倒放、静止）。
 *
 * @param value 播放速率（> 0 的有限数；1 = 原速）
 * @returns 恒速变速选项
 * @throws spec_violation 非正或非有限数时
 */
export function rate(value: number): AudioRate {
  if (!Number.isFinite(value) || value <= 0)
    throw violation(`rate(${value}) 须为 > 0 的有限数（禁倒放、静止）`);
  return { kind: "rate", value };
}

/**
 * 锚点式变速/踩点：`warp([0,0],[600,1200],[1000,"end"])`。
 *
 * 每项是 `[时间线毫秒, 源毫秒 | "end"]`；锚点之间线性插值、末点斜率延续；
 * 源位置必须递增（速率恒正，禁倒放），源尾标志 `"end"` 只允许出现在末位。
 *
 * @param points 锚点序列（至少一项；时间严格递增，源位置递增）
 * @returns 分段变速选项
 * @throws spec_violation 空表、时间未严格递增、源位置未递增或 "end" 位置非法时
 */
export function warp(
  ...points: ReadonlyArray<readonly [Ms, Ms | "end"]>
): AudioRate {
  if (points.length === 0) throw violation("warp() 至少需要一个锚点");
  const out: WarpPoint[] = [];
  let prevAt = -Infinity;
  let prevSrc = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const [atMs, srcMs] = points[i]!;
    if (!isMs(atMs))
      throw violation(`warp 第 ${i} 点时间 ${String(atMs)} 须为 ≥0 的有限毫秒`);
    if (atMs <= prevAt)
      throw violation(
        `warp 第 ${i} 点时间 ${atMs} 未严格递增（前一点 ${prevAt}）`,
      );
    prevAt = atMs;
    if (srcMs === "end") {
      if (i !== points.length - 1)
        throw violation(`warp 第 ${i} 点源尾 "end" 只允许末位`);
      out.push({ atMs, srcMs });
      continue;
    }
    if (!isMs(srcMs))
      throw violation(
        `warp 第 ${i} 点源位置 ${String(srcMs)} 须为 ≥0 的有限毫秒或 "end"`,
      );
    if (srcMs <= prevSrc)
      throw violation(
        `warp 第 ${i} 点源位置 ${srcMs} 未递增（前一点 ${prevSrc}）——速率须为正，禁倒放`,
      );
    prevSrc = srcMs;
    out.push({ atMs, srcMs });
  }
  return { kind: "warp", points: out };
}

/** 缺省增益：线性幅度 1（不改变原声） */
export const DEFAULT_GAIN: AudioGain = { value: 1 };
/** 缺省摆位：0（居中） */
export const DEFAULT_PAN: AudioPan = { value: 0 };

/**
 * 归一选项 → 声音记录所需的默认值（不改动用户传入的对象）。
 *
 * @param options 用户选项；省略则全部取缺省
 * @returns gain（缺省 1）、pan（缺省 0）、loop/rate（缺省 null）
 */
export function normalizeOptions(options?: AudioOptions): {
  readonly gain: AudioGain;
  readonly pan: AudioPan;
  readonly loop: AudioLoop | null;
  readonly rate: AudioRate | null;
} {
  return {
    gain: options?.gain ?? DEFAULT_GAIN,
    pan: options?.pan ?? DEFAULT_PAN,
    loop: options?.loop ?? null,
    rate: options?.rate ?? null,
  };
}

/**
 * 声音工厂：登记期与运行期共用，保证两种发射是同一形态。
 *
 * 缺省值在此归一（缺省增益 1、缺省摆位居中），因此消费方不必再判空。
 *
 * @param id 声音标识（段内唯一，运行期按它定位）
 * @param clipRef 片段引用
 * @param startMs 起点（毫秒）：调用方已全局化
 * @param options 播放选项（增益/摆位/循环/变速/总线）；缺省取归一后的默认值
 * @param ops 运行期操作记录（缺省空表）
 * @returns 声音记录
 */
export function makeVoice(
  id: string,
  clipRef: AudioClip,
  startMs: Ms,
  options?: AudioOptions,
  ops: AudioVoice["ops"] = [],
): AudioVoice {
  const n = normalizeOptions(options);
  return {
    id,
    clip: clipRef,
    startMs,
    gain: n.gain,
    pan: n.pan,
    loop: n.loop,
    rate: n.rate,
    ops,
    bus: options?.bus,
  };
}
