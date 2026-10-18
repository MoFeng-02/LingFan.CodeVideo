/**
 * 预览端资源加载契约：把 clip url 变成 AudioBuffer（宿主注入，通常 fetch + decodeAudioData）。
 *
 * 只在主线程调用；同一 url 的并发请求由 `WebAudioOutput` 的缓存合并成一次。
 * 返回的 AudioBuffer 保持原素材的采样率与声道数，转交错与重采样由输出端负责。
 */
export type AudioBufferLoader = (url: string) => Promise<AudioBuffer>;
