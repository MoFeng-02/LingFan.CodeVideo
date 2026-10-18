/**
 * 合成本帧要叠哪些层：纯函数，没有 GPU 也能测。
 *
 * 「什么时候显示哪一层」是剧本的一部分（推演语义），执行它的是后端；
 * 把这条判断抽成纯函数，才能在 Node 里断言它、也才能说清「合成是确定的」。
 */
import type { Ms } from "@lingfan-video/contracts";
import type { FrameLayer, LayerSpec } from "./types";

/** 层的可见区间判定：左闭右开，缺省整段可见 */
export function isLayerActive(spec: LayerSpec, timestampMs: Ms): boolean {
  if (spec.from !== undefined && timestampMs < spec.from) return false;
  if (spec.to !== undefined && timestampMs >= spec.to) return false;
  return true;
}

/**
 * 本帧的叠放次序：z 升序（同 z 保持声明顺序）。
 * 排序稳定是刻意的——同一剧本必须得到同一叠放顺序，否则输出不可复现。
 */
export function planComposite(
  layers: readonly FrameLayer[],
  timestampMs: Ms,
): readonly FrameLayer[] {
  const active = layers.filter((layer) =>
    isLayerActive(layer.spec, timestampMs),
  );
  return active
    .map((layer, index) => ({ layer, index }))
    .sort(
      (a, b) =>
        (a.layer.spec.z ?? 0) - (b.layer.spec.z ?? 0) || a.index - b.index,
    )
    .map((entry) => entry.layer);
}
