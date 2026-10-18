/**
 * 画面之外的声音设计：跟画面咬合的那些响动。
 *
 * 歌本身提供旋律与鼓，这里只补它没有的东西——段落的冲击、进入前的上行、
 * 切点的轻响、揭示的铃、间奏的铺底。位置全在小节线或拍点上，与画面同源。
 *
 * 这张表是纯数据：`song-audio.ts` 才把它变成声部。
 */
import { ACTS, actFrom, bar, beat, BEAT_MS } from "./timeline";

export type CueKind =
  /** 低频冲击（段落起点） */
  | "impact"
  /** 上行过门（重要段落入口前一两小节） */
  | "riser"
  /** 轻响（切点/弱拍呼吸） */
  | "tick"
  /** 铃（点名/揭示） */
  | "ping"
  /** 长低频铺底（安静段落） */
  | "drone"
  /** 高频扫过（水/风/光） */
  | "sweep"
  /** 收尾一击（歌停） */
  | "stop";

export interface Cue {
  readonly at: number;
  readonly kind: CueKind;
  /** 相对强度 0..1：决定增益与音高 */
  readonly power: number;
  readonly tag: string;
}

function build(): Cue[] {
  const cues: Cue[] = [];
  const push = (
    at: number,
    kind: CueKind,
    power: number,
    tag: string,
  ): void => {
    cues.push({ at: Math.round(at), kind, power, tag });
  };

  // 每段的起点给一次冲击：歌密的地方给得轻，别盖住鼓
  for (const [index, act] of ACTS.entries()) {
    if (index === 0) continue;
    const power = act.fps === 120 ? 1 : act.fps === 60 ? 0.7 : 0.5;
    push(act.from, "impact", power, act.id);
  }

  // 进入前的上行：破墙、格局变了、交给所有人、默认
  for (const id of ["open", "shift", "withyou", "now"]) {
    const act = actFrom(id);
    push(act.from - BEAT_MS * 4, "riser", 0.5, `${id}-riser`);
    push(act.from - BEAT_MS * 2, "riser", 0.78, `${id}-riser2`);
  }

  // 点名的那几段给一声铃
  for (const id of ["open", "shift", "me", "changed"]) {
    push(actFrom(id).from + BEAT_MS * 2, "ping", 0.65, `${id}-ping`);
  }

  // 前奏：长铺底 + 极轻的呼吸
  push(bar(1), "drone", 0.5, "intro-drone");
  push(bar(1) + BEAT_MS * 2, "tick", 0.22, "intro-tick");
  push(bar(3), "tick", 0.28, "intro-tick2");

  // 破墙：两道扫频配闪白
  push(actFrom("open").from + 40, "sweep", 1, "open-sweep");
  push(actFrom("open").from + BEAT_MS * 2, "sweep", 0.45, "open-sweep2");

  // 间奏（能量骤降）：低频托住，别让画面空掉
  const still = actFrom("still");
  push(still.from, "drone", 0.75, "still-drone");
  push(still.from + BEAT_MS * 6, "tick", 0.3, "still-tick");
  push(still.from + BEAT_MS * 10, "ping", 0.45, "still-ping");

  // 弱拍轻响：与鼓错开，制造"呼吸"
  for (let i = 0; i < 12; i += 1) {
    push(bar(36) + i * BEAT_MS * 2 + BEAT_MS, "tick", 0.16, `pulse-${i}`);
  }

  // 收束：两次扫频 + 歌停那一击
  push(actFrom("now").from + BEAT_MS * 4, "sweep", 0.55, "now-sweep");
  push(actFrom("hand").from, "impact", 1, "hand-impact");
  push(actFrom("hand").from + BEAT_MS * 4, "ping", 0.8, "hand-ping");
  push(133654, "stop", 1, "song-stop");

  // 拍点上的呼吸：只在前段与尾段，避免整片噪声化
  for (let k = 8; k <= 32; k += 4) push(beat(k), "tick", 0.14, `breath-${k}`);

  return cues.sort((a, b) => a.at - b.at);
}

export const CUES: readonly Cue[] = build();

/** 落在 [from, to) 里的响动 */
export function cuesIn(from: number, to: number): readonly Cue[] {
  return CUES.filter((c) => c.at >= from && c.at < to);
}
