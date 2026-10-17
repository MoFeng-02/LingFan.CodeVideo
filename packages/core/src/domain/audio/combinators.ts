/**
 * 音频组合子（域层纯函数）：把「写错的音频参数」挡在构造处。
 * 每个组合子返回不可变强类型值并在构造期校验——DSL 里不再出现裸数字袋：
 * 单位混淆（秒/毫秒）、相邻概念混用（音量 vs 增益、循环 vs 时长）都会当场报错。
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
  Ms,
  WarpPoint,
} from "@lingfan-video/contracts";

/** 契约违约（与引擎其它 spec_violation 同一命名纪律：message 前缀 + Error.name） */
function violation(message: string): Error {
  const err = new Error(`spec_violation: ${message}`);
  err.name = "SpecViolation";
  return err;
}

function isMs(v: unknown): v is Ms {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** 音频片段：url 指向 setup 阶段预解码的资产 */
export function clip(url: string): AudioClip {
  if (typeof url !== "string" || url.length === 0)
    throw violation(`clip(url) 须为非空字符串（收到 ${String(url)}）`);
  return { url, kind: "audio" } as AudioClip;
}

/** 音量与淡入淡出（线性增益；fade 在时间线毫秒域） */
export function gain(
  value: number,
  env?: {
    readonly fadeIn?: Ms;
    readonly fadeOut?: Ms;
    readonly envelope?: Envelope;
  },
): AudioGain {
  if (!Number.isFinite(value) || value < 0)
    throw violation(`gain(${value}) 须为 ≥0 的有限数`);
  const fadeIn = env?.fadeIn;
  const fadeOut = env?.fadeOut;
  if (fadeIn !== undefined && !isMs(fadeIn))
    throw violation(`gain.fadeIn=${String(fadeIn)} 须为 ≥0 的有限毫秒`);
  if (fadeOut !== undefined && !isMs(fadeOut))
    throw violation(`gain.fadeOut=${String(fadeOut)} 须为 ≥0 的有限毫秒`);
  return {
    value,
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
 * `ramp(0, 1, 300)` = 300ms 淡入到满；`ramp(1, 0, 300)` = 300ms 降到静音。
 */
export function ramp(from: number, to: number, ms: Ms): Envelope {
  return {
    points: envelopePoints([
      { atMs: 0, value: from },
      { atMs: ms, value: to },
    ]),
  };
}

/** 分段线性包络：折点须按局部毫秒严格递增；首个折点之前取首值。 */
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

/** 淡入（B6，ramp 的语法糖）：局部 0 → 1，ms 处满。 */
export function fadeIn(ms: Ms): Envelope {
  return ramp(0, 1, ms);
}

/**
 * 淡出（B6）：终点前 ms 开始从 1 降到 0，与声音实际终点对齐
 * （终点由源播完/stop/终界裁定，包络不需要预先知道时长）。
 */
export function fadeOut(ms: Ms): Envelope {
  return {
    points: envelopePoints([
      { atMs: ms, value: 1, fromEnd: true },
      { atMs: 0, value: 0, fromEnd: true },
    ]),
  };
}

/** 立体声摆位：-1（全左）~ 1（全右） */
export function pan(value: number): AudioPan {
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw violation(`pan(${value}) 须在 -1 ~ 1 之间`);
  return { value };
}

/** 循环：省略时长 = 铺到总时间线尾（终界仍是时间线） */
export function loop(untilMs?: Ms): AudioLoop {
  if (untilMs !== undefined && !isMs(untilMs))
    throw violation(`loop(${String(untilMs)}) 须为 ≥0 的有限毫秒`);
  return untilMs === undefined ? {} : { untilMs };
}

/** 恒速变速：value = 播放速率 = 音高倍率（须 > 0；禁倒放） */
export function rate(value: number): AudioRate {
  if (!Number.isFinite(value) || value <= 0)
    throw violation(`rate(${value}) 须为 > 0 的有限数（禁倒放、静止）`);
  return { kind: "rate", value };
}

/**
 * 锚点式变速/踩点：warp([0,0],[600,1200],[1000,"end"])。
 * 每项 [时间线毫秒, 源毫秒|"end"]；锚点之间线性插值，末点斜率延续；
 * 源尾标志 "end" 只允许末位。
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

/** 缺省选项（未给 gain/pan 时归一） */
export const DEFAULT_GAIN: AudioGain = { value: 1 };
export const DEFAULT_PAN: AudioPan = { value: 0 };

/** 归一选项 → 声音记录所需的默认值（不改动用户传入对象） */
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

/** 声音工厂：登记期与运行期共用（保证两种发射同一形态） */
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
