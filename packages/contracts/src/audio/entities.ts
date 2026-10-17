/** 音频片段引用：以 url 指向预解码资产（setup 阶段经 assets.load） */
export interface AudioClipRef {
  readonly url: string;
  readonly kind?: "audio";
}
