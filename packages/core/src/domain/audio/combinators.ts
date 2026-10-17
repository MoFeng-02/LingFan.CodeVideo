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
  env?: { readonly fadeIn?: Ms; readonly fadeOut?: Ms },
): AudioGain {
  if (!Number.isFinite(value) || value < 0)
    throw violation(`gain(${value}) 须为 ≥0 的有限数`);
  const fadeIn = env?.fadeIn;
  const fadeOut = env?.fadeOut;
  if (fadeIn !== undefined && !isMs(fadeIn))
    throw violation(`gain.fadeIn=${String(fadeIn)} 须为 ≥0 的有限毫秒`);
  if (fadeOut !== undefined && !isMs(fadeOut))
    throw violation(`gain.fadeOut=${String(fadeOut)} 须为 ≥0 的有限毫秒`);
  return fadeIn === undefined && fadeOut === undefined
    ? { value }
    : { value, fadeIn, fadeOut };
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
  };
}
