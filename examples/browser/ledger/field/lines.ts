/**
 * 线条写入的公共底座：一块整帧重写的 `Float32Array`、一个游标、以及
 * 十九个图形共用的散列与缓动。
 *
 * 这里不持有任何几何：`Wire` 只在一次写入过程中存在，图形靠它把端点
 * 落到缓冲里；段数与缓冲上限由这一层统一约束，图形只管画。
 */

/** 全片共用的段数上限；单个图形远低于它，缓冲区一次分配、永不重建 */
export const MAX_SEGMENTS = 9_000;

/** 色板只取策划里的线色；暖色只给"事件"那一镜 */
export const BRAND = 0x4d6bfe;
export const ICE = 0xa8beff;
export const INK = 0xf2f6ff;
export const WARM = 0xffc778;
export const DIM = 0x93a4c4;

/** 一个点；线段两端都写成三元组 */
export type P = readonly [number, number, number];

/**
 * 确定性散列：[0,1)。从 `vibe/stage.ts` 复制一份，示例之间不互相 import。
 * 图形里所有"随机"排列都来自它，同一时刻永远得到同一帧。
 */
export function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e37_79b9, 0x85eb_ca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 0xc2b2_ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4_294_967_296;
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 主曲线：策划规定的 smoothstep */
export const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

/**
 * 顶点游标：每段线写 6 个数，只写不读；超出缓冲直接丢弃——
 * 段数上限是设计约束，宁缺不崩。
 */
class Wire {
  at = 0;
  constructor(private readonly out: Float32Array) {}

  line(a: P, b: P): void {
    if (this.at >= MAX_SEGMENTS) return;
    const o = this.at * 6;
    this.out[o] = a[0];
    this.out[o + 1] = a[1];
    this.out[o + 2] = a[2];
    this.out[o + 3] = b[0];
    this.out[o + 4] = b[1];
    this.out[o + 5] = b[2];
    this.at += 1;
  }

  path(points: readonly P[]): void {
    for (let i = 1; i < points.length; i += 1) {
      this.line(points[i - 1]!, points[i]!);
    }
  }
}

type Draw = (w: Wire, t: number, local: number) => void;

export interface Glyph {
  readonly color: number;
  /** 本帧写入的段数；每帧重算，不跨帧保留 */
  segments: number;
  write(out: Float32Array, t: number, local: number): void;
}

/** 把"画图形"的闭包包成场：`write` 负责建游标、统计段数 */
export function glyph(color: number, draw: Draw): Glyph {
  const g: Glyph = {
    color,
    segments: 0,
    write(out, t, local) {
      const w = new Wire(out);
      draw(w, t, local);
      g.segments = w.at;
    },
  };
  return g;
}
