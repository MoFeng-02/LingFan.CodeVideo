import type { AssetLike } from "../scene";

/**
 * 资产来源契约：当前版本仅 load。
 * generate（AI 生成资产）后续版本接入：按 (prompt, seed, model 版本) 三元组缓存，
 * 导出模式未命中缓存时显式失败（确定性优先）。
 */
export interface AssetSource {
  load(url: string): Promise<AssetLike>;
}
