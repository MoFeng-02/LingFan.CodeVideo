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
}
