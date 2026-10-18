/**
 * 资产种类标识：开放集合。
 *
 * 引擎不解释资产内容、也不按种类分支——它只把 `AssetSource.load` 的结果原样交还给剧本代码与适配器。
 * 所以内置的这几个名字只是可读性约定；适配器自行约定的种类名同样合法，
 * 引入外部音视频、建模、字体、第三方引擎场景档都不需要改契约。
 */
export type AssetKind =
  "image" | "audio" | "video" | "model" | "font" | "data" | (string & {});

/**
 * 资产最小形态：来源标识 + 自解释种类 + 适配器定义的载荷。
 *
 * `payload` 是适配器的私有产物（`AudioBuffer`、`ImageBitmap`、`ArrayBuffer`、GLTF 文档、
 * 第三方引擎句柄……）。引擎既不做类型断言也不读它，只保证原样往返；
 * 因此「资源可以是任意产物」是契约层面的承诺，而不是某个后端的特权。
 */
export interface AssetLike {
  readonly url: string;
  readonly kind: AssetKind;
  readonly payload?: unknown;
  /**
   * 内容指纹（可选，算法由适配器自定，写成自解释字符串如 `sha256:9f2c…`）。
   * 清单声明了 `hash` 时，引擎会拿它与这条对账：不一致就在第一帧之前失败。
   * 资产悄悄换了一版、推演结果却变了，是确定性最隐蔽的敌人。
   */
  readonly hash?: string;
}

/**
 * 清单条目：逻辑 id → 取用地址，可选声明种类与内容指纹。
 *
 * 剧本按 `id` 取资产（也可按 `url`），引擎在构建期把 id 解析成 url；
 * 清单存在时，清单外的引用直接报错——不存在「大概加载到了」这种状态。
 */
export interface AssetManifestEntry {
  readonly id: string;
  readonly url: string;
  readonly kind?: AssetKind;
  readonly hash?: string;
}

/**
 * 资产清单：可被剧本取用的全部资产。
 *
 * 清单是数据而不是约定：同一份清单 + 同一批适配器 = 同一批字节。
 * 它不约束协议与编码，只回答「这次推演允许取哪些资产、它们应该是什么」。
 */
export interface AssetManifest {
  readonly entries: readonly AssetManifestEntry[];
}
