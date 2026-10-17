/**
 * 音频片段：由 clip() 工厂构造的 brand，不是「任意带 url 的对象」。
 * brand 的作用是让「把字符串/别的资源当音频传」在编译期就被拦下；
 * url 指向 setup 阶段经 assets.load 预解码的资产。
 */
declare const audioClipBrand: unique symbol;

export interface AudioClip {
  readonly url: string;
  readonly kind: "audio";
  readonly [audioClipBrand]: true;
}
