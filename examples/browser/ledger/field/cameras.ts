/**
 * 机位表：镜内只慢推、慢移、慢降，切点处允许整块跳；
 * 每个机位都为"这一镜的图形落在画面哪里"服务，不做连续运镜。
 */
import type { FieldId } from "../script";
import type { P } from "./lines";

export type CameraPlan = {
  readonly at: P;
  readonly look: P;
  readonly fov: number;
};

const cam = (at: P, look: P, fov: number): CameraPlan => ({ at, look, fov });

export const CAMERAS: Readonly<Record<FieldId, (local: number) => CameraPlan>> =
  {
    boot: (l) => cam([0, 0.5, 9.4 - l * 1.2], [0, -0.2, 0], 46),
    lattice: (l) => cam([-1.4 + l, 1.5, 9.2 - l * 1.4], [0, 0, -4], 48),
    tree: (l) => cam([0, 0.1, 10.2 - l * 1.6], [0, 0.4, 0], 50),
    open: (l) => cam([1.6 - l * 0.7, 1.3, 7.6 - l * 1.2], [0, 0, 0], 46),
    shock: (l) => cam([0, 1.1, 9.6 - l * 1.3], [0, -0.2, 0], 50),
    deck: (l) => cam([0, 3.2 - l * 1.1, 8.6 - l * 1.4], [0, -1.1, -4], 48),
    spiral: (l) => cam([0, 0.1, 8.2 - l * 1.4], [0, 0, 0], 46),
    tools: (l) => cam([0, 2.1 - l * 0.7, 7.2 - l * 1.1], [0, 0, 0], 48),
    steady: (l) => cam([0, 3 - l * 0.3, 7.4 - l * 0.5], [0, -0.5, -2.5], 50),
    mesh: (l) => cam([1.6, 2.4, 8.2 - l * 1.2], [0, 0, -1], 46),
    mix: (l) => cam([0.6, 1.3, 10 - l * 1.4], [0, 0, -1], 48),
    corridor: (l) => cam([0, 0.5, 6.6 - l * 1.2], [0, 0.3, -12], 56),
    tiers: (l) => cam([0.7 - l * 0.4, 2.6, 8.2 - l * 0.9], [0, -0.1, -3], 48),
    eye: (l) => cam([0, 0.1, 7.6 - l * 0.6], [0, 0.1, 0], 52),
    construct: (l) =>
      cam([2 - l * 0.6, 1.5, 7.8 - l * 1.3], [0, -0.4, -2.5], 48),
    track: (l) => cam([0, 4 - l, 8.4 - l], [0, 0, 0], 50),
    godot: (l) => cam([0, 0, 9.4 - l * 0.8], [0, 0, 0], 55),
    loop: (l) => cam([0, 0.3, 8 - l], [0, 0, 0], 46),
    settle: (l) => cam([0, 0.2, 10.4 - l * 1.6], [0, 0.1, 0], 50),
  };
