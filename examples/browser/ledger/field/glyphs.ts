/**
 * 十九个图形按场记名汇总。每帧只取其中一个，切镜即整块替换；
 * 表本身是只读的，图形内部的段数在 `Glyph.write` 里逐帧重算。
 */
import type { FieldId } from "../script";
import type { Glyph } from "./lines";
import {
  boot,
  deck,
  lattice,
  mesh,
  open,
  shock,
  spiral,
  steady,
  tools,
  tree,
} from "./glyphs-a";
import {
  construct,
  corridor,
  eye,
  godot,
  loop,
  mix,
  settle,
  tiers,
  track,
} from "./glyphs-b";

export const GLYPHS: Readonly<Record<FieldId, Glyph>> = {
  boot,
  lattice,
  tree,
  open,
  shock,
  deck,
  spiral,
  tools,
  steady,
  mesh,
  mix,
  corridor,
  tiers,
  eye,
  construct,
  track,
  godot,
  loop,
  settle,
};
