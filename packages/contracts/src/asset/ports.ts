import type { AssetLike } from "./entities";

/**
 * 资产来源契约：按 URL 加载资产，原样交回。
 *
 * 契约只约定「能按 URL 拿到一个 `AssetLike`」：不约定协议、编码、缓存策略，
 * 也不规定必须有一份清单——那是适配器与后续确定性缓存层的事。
 * 实现方可以是 fetch、文件系统、打包器内联表、第三方引擎的 loader。
 */
export interface AssetSource {
  load(url: string): Promise<AssetLike>;
}
