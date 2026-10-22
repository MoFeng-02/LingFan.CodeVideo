/**
 * 遮罩层：压在三维场上的三块暗底，让读数在亮背景上读得清。
 *
 * 它是**一层**，不是装配开关。画面里有没有这一层由剧本说（`env.layer`），
 * 装配只负责按层 id 交面——这样「素材要透明」与「成片要压暗」是两份不同的
 * 剧本（声明不同的层），而不是同一份剧本换一个布尔值。
 *
 * 它不随时间变化：`paint` 每次从干净画布重画同一批渐变，输出与上一帧无关。
 */
import type { LayerSurface } from "@lingfan-video/infra";
import { DESIGN } from "../script";
import type { LedgerState } from "../program";
import { paintScrims } from "../type/endcard";

/** 遮罩层：一块画布、一个面 */
export interface ScrimLayer {
  readonly surface: LayerSurface;
  /** 由剧本的 fn 每帧调用：擦掉上一帧再铺一遍 */
  paint(state: LedgerState): void;
  dispose(): void;
}

/**
 * 造遮罩层。
 *
 * @param width 画布宽（像素）
 * @param height 画布高（像素）
 * @returns 遮罩层
 */
export function createScrim(width: number, height: number): ScrimLayer {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("遮罩层拿不到 2D 上下文：当前环境不支持 Canvas2D");
  return {
    surface: {
      id: "scrim",
      width,
      height,
      canvas,
      render(_frame, _timestampMs) {
        // 像素已由 fn 调 paint 时画好：这里只把画布交给宿主
      },
    },
    paint(_state: LedgerState) {
      const scale = g.canvas.height / DESIGN.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      g.scale(scale, scale);
      paintScrims(g);
    },
    dispose() {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
