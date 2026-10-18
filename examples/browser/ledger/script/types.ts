/** 剧本的数据形状：采样密度、三维图形名、镜头类别、一枚读数、一段的内容。 */
import type { Ms } from "@lingfan-video/contracts";

/** 设计坐标：二维层按 640×360 画，再按实际高度放大 */
export const DESIGN = { width: 640, height: 360 };

/** 采样密度：本段声明的 fps。静场 30 / 推移 60 / 生长 90 / 粒子与快切 120 */
export type Fps = 30 | 60 | 90 | 120;

/** 三维信号场的图形 id */
export type FieldId =
  | "boot"
  | "lattice"
  | "tree"
  | "open"
  | "shock"
  | "deck"
  | "spiral"
  | "tools"
  | "steady"
  | "mesh"
  | "mix"
  | "corridor"
  | "tiers"
  | "eye"
  | "construct"
  | "track"
  | "godot"
  | "loop"
  | "settle";

/** 镜头的类别：二维层与配乐按它决定画什么、响什么 */
export type Mode =
  "boot" | "version" | "event" | "works" | "loop" | "settle" | "endcard";

/** 一枚读数：数字先落地，单位后到 */
export interface Reading {
  readonly value: string;
  readonly unit: string;
}

/** 一段：自己的帧窗池长度、采样密度、图形与文案 */
export interface Shot {
  readonly id: string;
  /** 本段的帧窗池长度（毫秒）；整条链的口径就是各段之和 */
  readonly length: Ms;
  readonly fps: Fps;
  readonly field: FieldId;
  readonly mode: Mode;
  /** 版本代号：也用来在刻度尺上落一枚印章（同一代号只落一次） */
  readonly code?: string;
  /** 日期（等宽小字） */
  readonly date?: string;
  /** 能力词（31px 大字） */
  readonly verb?: string;
  /** 读数：按顺序落，每枚间隔 900ms */
  readonly readings?: readonly Reading[];
  /** 一行说明（≤20 字） */
  readonly caption?: string;
  /** 重拍：配乐在这镜起点给一记重击 */
  readonly accent?: boolean;
}
