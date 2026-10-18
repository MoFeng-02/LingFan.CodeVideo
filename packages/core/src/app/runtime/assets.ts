import type {
  AssetLike,
  AssetManifestEntry,
  AssetSource,
} from "@lingfan-video/contracts";
import type { AssetIndex, TimelineState } from "./engine-types";
import { makeRenderError } from "./error";

/** 统一的资产失败：一律 spec_violation，光标钉在 0（构建期，还没走到任何帧） */
function fail(sceneId: string, message: string): Error {
  return makeRenderError("spec_violation", sceneId, 0, message);
}

/**
 * 读清单并建索引：id 与 url 各自唯一、都非空。
 * 每次推演只读一次（适配器的清单属于本次推演，跨推演不共享）。
 */
function readIndex(state: TimelineState, sceneId: string): AssetIndex | null {
  if (state.assetIndexRead) return state.assetIndex;
  const source = state.opts.assets;
  const manifest = source?.manifest?.();
  if (manifest === undefined) {
    state.assetIndexRead = true;
    return null;
  }
  const byId = new Map<string, AssetManifestEntry>();
  const byUrl = new Map<string, AssetManifestEntry>();
  for (const [i, entry] of manifest.entries.entries()) {
    const at = `资产清单第 ${i + 1} 条`;
    const { id, url } = entry;
    if (typeof id !== "string" || id === "")
      throw fail(sceneId, `${at}缺少 id`);
    if (typeof url !== "string" || url === "")
      throw fail(sceneId, `${at}缺少 url`);
    if (byId.has(id)) throw fail(sceneId, `${at}的 id 重复：${id}`);
    if (byUrl.has(url)) throw fail(sceneId, `${at}的 url 重复：${url}`);
    byId.set(id, entry);
    byUrl.set(url, entry);
  }
  const index: AssetIndex = { entries: manifest.entries, byId, byUrl };
  state.assetIndex = index;
  state.assetIndexRead = true;
  return index;
}

/** 载荷到手之后的对账：种类与内容指纹都必须与清单一致 */
async function verify(
  pending: Promise<AssetLike>,
  entry: AssetManifestEntry | undefined,
  url: string,
  sceneId: string,
): Promise<AssetLike> {
  const asset = await pending;
  if (entry === undefined) return asset;
  if (entry.kind !== undefined && asset.kind !== entry.kind)
    throw fail(
      sceneId,
      `资产种类与清单不符：${url}（清单 ${entry.kind}，实际 ${asset.kind}）`,
    );
  if (entry.hash !== undefined) {
    if (asset.hash === undefined)
      throw fail(sceneId, `资产未报告内容指纹，清单要求 ${entry.hash}：${url}`);
    if (asset.hash !== entry.hash)
      throw fail(
        sceneId,
        `资产内容与清单不符：${url}（清单 ${entry.hash}，实际 ${asset.hash}）`,
      );
  }
  return asset;
}

/**
 * 构建期的资产加载器：解析清单引用、校验内容、按本次推演缓存。
 *
 * - 有清单：引用按 id 或 url 解析，清单外直接失败（不存在「大概加载到了」）
 * - 无清单：引用就是 url（向后兼容，也不做内容对账）
 * - 缓存键含 id 与 url：同一资产无论被几个场景、几次引用，只加载一次
 *
 * 配置类错误同步抛出（引用为空、无 AssetSource、清单缺条目、清单本身非法）：
 * 这样 `void load(...)` 这种忘记 await 的写法也会在第一帧之前暴露，
 * 而不是变成一个没人看见的 unhandled rejection。
 */
export function makeAssetLoader(
  state: TimelineState,
  sceneId: string,
): (ref: string) => Promise<AssetLike> {
  return (ref: string): Promise<AssetLike> => {
    const source: AssetSource | undefined = state.opts.assets;
    if (source === undefined)
      throw fail(
        sceneId,
        "assets.load：引擎未装配 AssetSource（组合根缺省应注入 fail-fast 实现）",
      );
    if (typeof ref !== "string" || ref === "")
      throw fail(sceneId, "assets.load：引用必须是非空字符串");
    const index = readIndex(state, sceneId);
    const entry = index?.byId.get(ref) ?? index?.byUrl.get(ref);
    if (index !== null && entry === undefined)
      throw fail(
        sceneId,
        `资产不在清单里：${ref}（清单共 ${index.entries.length} 条）`,
      );
    const url = entry?.url ?? ref;
    const key = entry === undefined ? url : `${entry.id}\u0000${url}`;
    const cached = state.assetCache.get(key);
    if (cached !== undefined) return cached;
    const pending = verify(source.load(url), entry, url, sceneId);
    state.assetCache.set(key, pending);
    return pending;
  };
}
