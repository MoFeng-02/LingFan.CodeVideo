/**
 * 片场装配：把剧本里的层声明配成宿主，并交回同一份程序。
 *
 * 这支片子是**多后端**的：一块 WebGL 画布画三维，一块 2D 画布画字，
 * 由合成宿主按 z 叠成一张画面。预览与导出各建一套（尺寸不同），互不影响。
 *
 * 合成器两档，预览与导出各选一档：
 * - 预览要跟音频时钟实时放：GPU 档每帧要把三块画布当纹理重传，主线程跟不上
 *   实时节奏；CPU 档的 `drawImage` 本身走 GPU，所以预览用 CPU。
 * - 导出要吞吐，且希望合成结果直接进编码器：用 GPU 档，零拷贝进 `VideoFrame`。
 * 两档叠出来的是同一张画（同一批层、同一个 z 序），差别只在谁叠。
 */
import type { LayerSurface } from "@lingfan-video/infra";
import {
  createCanvas2dCompositor,
  createCompositeHost,
} from "@lingfan-video/infra";
import { createThreeCompositor } from "@lingfan-video/infra/frames/adapters/three-compositor";

import { createField } from "./ledger/field";
import { buildProgram } from "./ledger/program";
import { CHAPTERS } from "./ledger/script";
import { createType } from "./ledger/type";

export function makeStageHost(
  canvas: HTMLCanvasElement,
  gpu: boolean,
  width: number,
  height: number,
) {
  const field = createField(width, height);
  const type = createType(width, height);
  // 层声明按镜给 id，宿主按 id 交面：画布是共享的，只是每镜一个别名的面
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
    candidates: gpu
      ? [() => createThreeCompositor(), () => createCanvas2dCompositor()]
      : [() => createCanvas2dCompositor()],
  });
  return { host, program: buildProgram({ field, type }) };
}
