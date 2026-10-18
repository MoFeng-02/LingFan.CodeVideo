/** 预览端资源加载契约：把 clip url 变成 AudioBuffer（宿主注入，通常 fetch + decodeAudioData）。 */
export type AudioBufferLoader = (url: string) => Promise<AudioBuffer>;
