/** 一个响动的形状：只说落在哪一段的第几毫秒，不带全片时刻。 */
export type CueKind =
  | "drone"
  | "pad"
  | "tick"
  | "stamp"
  | "impact"
  | "ping"
  | "noise"
  | "kick"
  | "hat"
  | "stop";

export interface Cue {
  /** 落在哪一段 */
  readonly shot: string;
  /** 段内偏移：剧本按它把响动登记进本段窗口 */
  readonly localAt: number;
  readonly kind: CueKind;
  readonly power: number;
  readonly freq?: number;
  readonly tag: string;
}
