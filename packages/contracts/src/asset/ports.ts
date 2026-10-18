import type { AssetLike, AssetManifest } from "./entities";

/**
 * 资产来源契约：按引用加载资产，原样交回。
 *
 * 契约只约定「能按引用拿到一个 `AssetLike`」：不约定协议、编码、缓存策略。
 * 实现方可以是 fetch、文件系统、打包器内联表、第三方引擎的 loader。
 *
 * 引用默认是 URL；实现 `manifest()` 之后，清单就能把逻辑 id 解析成 URL，
 * 清单外的引用在构建期（第一帧之前）报错。引擎负责解析、校验与本次推演内的缓存，
 * 适配器只负责「给一个字节来源」。
 */
export interface AssetSource {
  load(ref: string): Promise<AssetLike>;
  /**
   * 可选清单：声明本适配器这次推演能提供哪些资产。
   * 返回 `undefined` 表示没有清单，`load` 收到什么就按 URL 原样加载（向后兼容）。
   */
  manifest?(): AssetManifest | undefined;
}
