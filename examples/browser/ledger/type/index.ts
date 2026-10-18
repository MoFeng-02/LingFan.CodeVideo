/**
 * 二维层：这台仪器的读数面。
 *
 * 全片只有四样东西：顶栏、主读数块、底部刻度尺、落版。
 * 层不认识镜头，也不看时间轴：`paint(state)` 画的就是 fn 这一帧算出来的状态；
 * 时刻用引擎给的 `state.t`，段内节奏用 `state.local`。
 * 设计坐标 640×360，按实际高度等比放大；排版只在设计坐标里算一次。
 */
import type { LayerSurface } from "@lingfan-video/infra";
import { DESIGN } from "../script";
import type { LedgerState } from "../program";
import { paintEndCard, paintScrims } from "./endcard";
import { paintHero } from "./hero";
import { paintRuler, paintTopBar } from "./chrome";
function paint(g: CanvasRenderingContext2D, state: LedgerState): void {
  const scale = g.canvas.height / DESIGN.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  g.scale(scale, scale);
  g.textBaseline = "alphabetic";

  // 这一帧的事实只有一份：二维层照 fn 的输出来画，不自己再算一遍
  paintScrims(g);
  paintHero(g, state);
  paintRuler(g, state);
  paintTopBar(g, state);
  if (state.mode === "endcard") paintEndCard(g, state);
}

/** 二维层：一块画布、一个面；画哪一镜由 fn 每帧给的 state 决定，层本身不按段重声明。 */
export interface TypeLayer {
  readonly surface: LayerSurface;
  /** 由剧本的 fn 每帧调用：画的就是这一帧算出来的状态 */
  paint(state: LedgerState): void;
  dispose(): void;
}

export function createType(width: number, height: number): TypeLayer {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("二维层拿不到 2D 上下文：当前环境不支持 Canvas2D");
  return {
    surface: {
      id: "type",
      width,
      height,
      canvas,
      render(_frame, _timestampMs) {
        // 像素已由 fn 调 paint 时画好：这里只把画布交给宿主，不再按时间重算
      },
    },
    paint(state: LedgerState) {
      paint(g, state);
    },
    dispose() {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
