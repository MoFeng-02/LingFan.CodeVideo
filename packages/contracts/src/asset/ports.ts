import type { AssetLike } from "../scene";

/**
 * 资产来源契约：按 URL 加载资产。
 */
export interface AssetSource {
  load(url: string): Promise<AssetLike>;
}
