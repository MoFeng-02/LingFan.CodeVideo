/** 品牌标记的类型载体：运行期不存在，只用于让 AudioClip 无法被结构相同的对象冒充 */
declare const audioClipBrand: unique symbol;

/**
 * 音频片段：由 clip() 工厂构造的 brand，不是「任意带 url 的对象」。
 * brand 的作用是让「把字符串/别的资源当音频传」在编译期就被拦下；
 * url 指向 setup 阶段经 assets.load 预解码的资产。
 */
export interface AudioClip {
  /** 资产来源标识：setup 阶段经 assets.load 预解码的那一个 */
  readonly url: string;
  /** 种类判别符，固定 "audio" */
  readonly kind: "audio";
  /** 仅用于类型区分的品牌，运行期无实际字段 */
  readonly [audioClipBrand]: true;
}
