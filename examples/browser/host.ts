/**
 * 片场装配：把剧本里的层声明配成宿主，并交回同一份程序。
 *
 * 这支片子是**多后端**的：一块 WebGL 画布画三维，一块 2D 画布画字，一块 2D 画布铺遮罩，
 * 由合成宿主按 z 叠成一张画面。预览与导出各建一套（尺寸不同），互不影响。
 *
 * 合成器候选由**装配方给**：宿主只按顺序取第一个能用的，不判断「哪种场景该用哪种后端」。
 * 预览要跟音频时钟实时放，所以只给 CPU 档（`drawImage` 本身走 GPU）；导出要吞吐，
 * 先给 GPU 档（零拷贝进 `VideoEncoder`），失败再退 CPU。两档叠出来的是同一张画。
 *
 * 两个入口的差别是**剧本里有没有遮罩这一层**，不是某个开关：
 * - `makeStageHost`：成片。三维场、读数、压暗遮罩三层都有；
 * - `makeMaterialStage`：透明素材。只有三维场与读数——素材要叠在别人的画面上，
 *   铺满整幅的暗底会把 alpha 填死，所以这份剧本根本不声明遮罩层。
 */
import type { Compositor, LayerSurface } from "@lingfan-video/infra";
import {
  createCanvas2dCompositor,
  createCompositeHost,
} from "@lingfan-video/infra";

import { createField } from "./ledger/field";
import type { FieldLayer } from "./ledger/field";
import type { Painters } from "./ledger/frames/frame";
import { buildProgram, type LedgerProgram } from "./ledger/program";
import { createScrim } from "./ledger/scrim";
import type { ScrimLayer } from "./ledger/scrim";
import { CHAPTERS } from "./ledger/script";
import { createType } from "./ledger/type";
import type { TypeLayer } from "./ledger/type";

/** 一次装配的产物：宿主、画面层与程序 */
export interface Stage {
  readonly host: ReturnType<typeof createCompositeHost>;
  /** 程序：层由 `painters` 决定（成片三层，素材两层） */
  readonly program: LedgerProgram;
  readonly field: FieldLayer;
  readonly type: TypeLayer;
}

/** 成片的装配产物：多一层压暗遮罩 */
export interface FilmStage extends Stage {
  readonly scrim: ScrimLayer;
}

/** 一次装配的可选项 */
export interface StageOptions {
  /**
   * 合成器候选，按尝试顺序；缺省只给 CPU 档。
   *
   * 导出端给 `[three, canvas2d]` 是为了让合成结果直接进编码器；预览端给 CPU 档
   * 是因为 GPU 档每帧要把三块画布当纹理重传，主线程跟不上实时节奏。
   */
  readonly compositors?: readonly (() => Compositor | null)[];
}

/** 按尺寸造三层画面层，并交回各自的画法 */
function createSurfaces(width: number, height: number) {
  const field = createField(width, height);
  const type = createType(width, height);
  const scrim = createScrim(width, height);
  return { field, type, scrim };
}

/**
 * 按尺寸造一套片场。
 *
 * @param canvas 合成底图（引擎把这张画布当画面底板）
 * @param width 画面宽（像素）
 * @param height 画面高（像素）
 * @param options 合成器候选
 * @returns 宿主、三支画面层与成片程序
 */
export function makeStageHost(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  options: StageOptions = {},
): FilmStage {
  const { field, type, scrim } = createSurfaces(width, height);
  const painters: Painters = { field, type, scrim };

  // 层声明按镜给 id，宿主按 id 交面：画布是共享的，只是每镜一个别名的面
  const surfaces: Record<string, LayerSurface> = {};
  for (const shot of CHAPTERS.flat()) {
    surfaces[`field:${shot.id}`] = { ...field.surface, id: `field:${shot.id}` };
    surfaces[`scrim:${shot.id}`] = { ...scrim.surface, id: `scrim:${shot.id}` };
    surfaces[`type:${shot.id}`] = { ...type.surface, id: `type:${shot.id}` };
  }
  // 遮罩不逐镜造面时也要能配对：剧本只在有成片才声明它，素材那份不会点名
  const host = createCompositeHost({
    base: canvas,
    width,
    height,
    surfaces,
    candidates: options.compositors ?? [() => createCanvas2dCompositor()],
  });

  return { host, program: buildProgram(painters), field, type, scrim };
}

/**
 * 按尺寸造一套**透明素材**用的片场：没有遮罩这一层。
 *
 * 剧本是同一份（同样的镜、同样的层 id、同样的采样密度），只是不声明遮罩——
 * 透明产物要叠在别人的画面上，铺满整幅的暗底会把 alpha 通道填死。
 *
 * @param canvas 合成底图
 * @param width 画面宽（像素）
 * @param height 画面高（像素）
 * @param options 合成器候选
 * @returns 宿主、两支画面层与不带遮罩的程序
 */
export function makeMaterialStage(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  options: StageOptions = {},
): Stage {
  const { field, type } = createSurfaces(width, height);
  const painters: Painters = { field, type };

  const surfaces: Record<string, LayerSurface> = {};
  for (const shot of CHAPTERS.flat()) {
    surfaces[`field:${shot.id}`] = { ...field.surface, id: `field:${shot.id}` };
    surfaces[`type:${shot.id}`] = { ...type.surface, id: `type:${shot.id}` };
  }
  const host = createCompositeHost({
    base: canvas,
    width,
    height,
    surfaces,
    candidates: options.compositors ?? [() => createCanvas2dCompositor()],
  });

  return { host, program: buildProgram(painters), field, type };
}
