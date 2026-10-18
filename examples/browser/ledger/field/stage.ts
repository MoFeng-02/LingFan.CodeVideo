/**
 * 《刻度》的三维信号场：全片只有一条线。
 *
 * 画面语言是"测量"：每镜不换场景树，只换一个纯函数图形——给定故事时间，
 * 算出这一帧该有的线段端点。所以切镜就是清场：上一镜的图形整块消失，
 * 不靠 visible、不做懒建、不留任何跨帧状态。
 *
 * 整层只有一个 `Float32Array(MAX_SEGMENTS * 6)`、一个 `LineSegments`、
 * 一份线材质。每帧由本段图形的 `field` 取图形、整块重写顶点，只改颜色与绘制范围。
 * 加性混合只负责让线在暗底上"发光"，不负责高亮：同一段线只写一次，
 * 亮度由色板与不透明度给，重叠处才不会烧成白块。
 *
 * 一块画布、一个渲染器，全片只交出**一个渲染面**：图形进度按"同一图形的整段"算，
 * 所以同场连镜接着走，不同场才整块换掉。
 */
import * as THREE from "three";
import { createThreeLayer } from "@lingfan-video/infra/frames/adapters/three";
import type { LayerSurface } from "@lingfan-video/infra";
import type { FrameIndex, Ms } from "@lingfan-video/contracts";
import type { LedgerState } from "../program";
import { CAMERAS } from "./cameras";
import { GLYPHS } from "./glyphs";
import { BRAND, MAX_SEGMENTS } from "./lines";

/** 取景：整体右移（把左半边让给读数），视角缩一档（线条不贴边被裁） */
const FRAME = { shift: 0.17, zoom: 1.12 } as const;

export interface FieldLayer {
  readonly surface: LayerSurface;
  /** 由剧本的 fn 每帧调用：画的就是这一帧算出来的状态，不按时间反查镜头 */
  paint(state: LedgerState): void;
  dispose(): void;
}

export function createField(width: number, height: number): FieldLayer {
  // 顶点缓冲只分配一次：每帧整块重写，哪段有效由 drawRange 决定
  const positions = new Float32Array(MAX_SEGMENTS * 6);
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute("position", attribute);
  const material = new THREE.LineBasicMaterial({
    color: BRAND,
    transparent: true,
    opacity: 0.55,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  // 包围球不会随整块重写更新：交给场景剔除会让线条成帧时隐时现
  lines.frustumCulled = false;

  // 当前这一帧的状态：由 fn 每帧写进来（画面层不自己按时间猜镜头）
  let active: LedgerState | null = null;

  const layer = createThreeLayer({
    spec: { id: "field", z: 0, from: 0 },
    width,
    height,
    createCamera: ({ width: w, height: h }) =>
      new THREE.PerspectiveCamera(46, w / h, 0.1, 120),
    build({ scene }) {
      scene.add(lines);
    },
    update(_t, _frame, ctx) {
      if (!active) return;
      // 图形与进度都来自这一帧的状态：同场连镜的进度由 fn 的 runLocal 给
      const state = active;
      const local = state.phase;
      const name = state.field;
      const field = GLYPHS[name];
      // 每帧从零重写：上一镜的图形不会以任何形式残留下来
      field.segments = 0;
      field.write(positions, state.t, local);
      geometry.setDrawRange(0, field.segments * 2);
      attribute.needsUpdate = true;
      material.color.setHex(field.color);
      const plan = CAMERAS[name](local);
      const camera = ctx.camera as THREE.PerspectiveCamera;
      camera.position.set(...plan.at);
      camera.lookAt(...plan.look);
      // 取景统一右移一档、再缩一点：左边留给读数，图形不贴边、不进文字区
      camera.fov = plan.fov * FRAME.zoom;
      camera.setViewOffset(
        width,
        height,
        -width * FRAME.shift,
        0,
        width,
        height,
      );
      camera.updateProjectionMatrix();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  });

  return {
    surface: {
      id: "field",
      width,
      height,
      // 整层共用一块画布：像素在 fn 调 paint 时就已经画好，取帧时只是把它交出去
      canvas: layer.surface.canvas,
      render(_frame: FrameIndex, _timestampMs: Ms) {
        // 画面由推演支路的 fn 画：这里不再按时间重算，避免两套口径
      },
    },
    paint(state: LedgerState) {
      active = state;
      layer.surface.render(0, state.t);
    },
    dispose() {
      layer.surface.dispose?.();
    },
  };
}
