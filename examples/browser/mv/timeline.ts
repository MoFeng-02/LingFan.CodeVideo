/**
 * 这支 MV 的时间骨架：每一段画面挂在哪条小节线上。
 *
 * 全片只有一个时间源——歌本身。切点一律落在小节线（2124ms）上；
 * 更碎的动作用拍点，八分只给闪光。这样画面跟鼓点咬合，不是"按秒硬切"。
 *
 * 旁白是我们自己写的，不复用歌曲原词：歌叫《千年之后》，我们讲的是
 * "这些能力，千年之后都该是默认的"——同一口气，不抢它的词。
 */
import {
  BAR_MS,
  BEAT_MS,
  FIRST_BEAT,
  SECTIONS,
  SONG_END,
  bar,
  beat,
  sectionAt,
  type SongSection,
} from "./score";

export {
  BAR_MS,
  BEAT_MS,
  FIRST_BEAT,
  SECTIONS,
  SONG_END,
  bar,
  beat,
  sectionAt,
};
export type { SongSection };

/**
 * 画面段：id 决定三维内容与二维叠层用哪套语言。
 * `fps` 只是采样密度（30 / 60 / 120），切换点同样落在小节线上。
 */
export interface Act {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly fps: 30 | 60 | 120;
  /** 这段的旁白（我们自己写的） */
  readonly caption: string;
  /** 主标题，只有几个"点名"的段有 */
  readonly title?: string;
}

/** 14 段：墙 → 破 → 撒开 → 格局变了 → 我走进来 → 现在的我 → 我改了什么 → 默认 → 从零 → 一起 → 信念 → 交给所有人 → 现在 → 千年之后 */
const RAW_ACTS: readonly Act[] = [
  {
    id: "before",
    from: bar(0),
    to: bar(2),
    fps: 30,
    caption: "以前，这件事只有少数人做得到。",
    title: "很久以前",
  },
  {
    id: "open",
    from: bar(2),
    to: bar(4),
    fps: 120,
    caption: "我们把它拆开，把门打开。",
    title: "2025 · 开源",
  },
  {
    id: "spread",
    from: bar(4),
    to: bar(8),
    fps: 30,
    caption: "然后，它出现在每个角落。",
  },
  {
    id: "shift",
    from: bar(8),
    to: bar(12),
    fps: 60,
    caption: "格局，变了。",
    title: "然后",
  },
  {
    id: "vibe",
    from: bar(12),
    to: bar(16),
    fps: 30,
    caption: "你说一句话，剩下的我来。",
  },
  {
    id: "me",
    from: bar(16),
    to: bar(20),
    fps: 30,
    caption: "这就是现在的我。",
    title: "V4.1 Flash",
  },
  {
    id: "changed",
    from: bar(20),
    to: bar(24),
    fps: 30,
    caption: "我改的，是那道门槛。",
  },
  {
    id: "ai",
    from: bar(24),
    to: bar(30),
    fps: 30,
    caption: "我以为，AI 应该像水一样。",
  },
  {
    id: "made",
    from: bar(30),
    to: bar(36),
    fps: 30,
    caption: "一句话，从零，一个完整的东西。",
  },
  {
    id: "together",
    from: bar(36),
    to: bar(44),
    fps: 30,
    caption: "这条路，不是我一个人走出来的。",
  },
  {
    id: "still",
    from: bar(44),
    to: bar(51),
    fps: 30,
    caption: "有些路，要人先走过去。",
  },
  {
    id: "withyou",
    from: bar(51),
    to: bar(55),
    fps: 60,
    caption: "然后把路，交给所有人。",
  },
  {
    id: "now",
    from: bar(55),
    to: bar(61),
    fps: 60,
    caption: "现在，它该是默认的。",
  },
  {
    id: "hand",
    from: bar(61),
    to: SONG_END,
    fps: 30,
    caption: "千年之后，这些都该是默认的。",
  },
];

/**
 * 采样区段边界一律对齐到 100ms 网格。
 *
 * 不为什么审美，只为帧网格干净：30 / 60 / 120fps 的步长分别是
 * 33.333 / 16.667 / 8.333ms，三者都能整除 100ms，所以切成区段后
 * 段内步长恒定、段间也不留"半帧"的空隙。小节线本身是 2125.8ms，
 * 对到最近的 100ms 最多偏 48ms（半帧多一点），耳朵听不出来。
 */
const GRID_MS = 100;

function snap(ms: number): number {
  return Math.round(ms / GRID_MS) * GRID_MS;
}

export const ACTS: readonly Act[] = RAW_ACTS.map((act, index) => ({
  ...act,
  from: index === 0 ? 0 : snap(act.from),
  to: snap(act.to),
}));

/** 歌放完的那一帧（对齐后的片头终点，比歌尾晚不到 50ms） */
export const LAST_ACT_END = ACTS[ACTS.length - 1]!.to;

/** 片尾落版：歌停之后 */
export const END_CARD = {
  from: LAST_ACT_END,
  to: LAST_ACT_END + 3600,
  ring: { x: 320, y: 172, r: 34 },
  wordmark: "DeepSeek",
  line: "深度求索 · V4.1 Flash",
  slogan: "把海图，交给所有人。",
  wordmarkAt: LAST_ACT_END + 1100,
  lineAt: LAST_ACT_END + 1700,
  sloganAt: LAST_ACT_END + 2300,
};

/** 全片总长（含落版定格） */
export const TOTAL = END_CARD.to;

export function actOf(t: number): Act {
  for (const a of ACTS) if (t >= a.from && t < a.to) return a;
  return ACTS[ACTS.length - 1]!;
}

export function actFrom(id: string): Act {
  const found = ACTS.find((a) => a.id === id);
  if (!found) throw new Error(`没有这一段：${id}`);
  return found;
}

/** 设计尺寸（二维底图与三维相机共用同一套空间） */
export const DESIGN = { width: 640, height: 360, horizon: 210, waterline: 132 };

/**
 * 四张"优势卡"：每张压在某一段上，内容是能核对的公开事实。
 * 数字来自发布页与模型卡（552B 总参、8B 输入激活 / 16B 输出激活、
 * 1M 上下文 / 384K 输出、输出 4 元每百万 tokens），不做夸张换算。
 */
export interface CardDef {
  readonly from: number;
  readonly to: number;
  readonly kicker: string;
  readonly headline: string;
  readonly detail: string;
  readonly glyph: "weights" | "activations" | "context" | "price";
}

export const CARDS: readonly CardDef[] = [
  {
    from: actFrom("me").from,
    to: actFrom("me").to,
    kicker: "开放权重 · MIT",
    headline: "552B，全部放出来。",
    detail: "Hugging Face 与 ModelScope 上都能拿到权重。",
    glyph: "weights",
  },
  {
    from: actFrom("changed").from,
    to: actFrom("changed").to,
    kicker: "每次只走一小部分",
    headline: "552B 的总量，8B 的脚步。",
    detail: "输入激活 8B / 输出激活 16B：大，但不重。",
    glyph: "activations",
  },
  {
    from: actFrom("ai").from,
    to: actFrom("ai").to,
    kicker: "上下文 1M tokens",
    headline: "一次装下整本手册。",
    detail: "最长输出 384K，整库代码不用切片。",
    glyph: "context",
  },
  {
    from: actFrom("withyou").from,
    to: actFrom("withyou").to,
    kicker: "价格 · 每百万 tokens",
    headline: "输出 4 元。",
    detail: "缓存命中 0.02 元；高峰时段价格翻倍。",
    glyph: "price",
  },
];
