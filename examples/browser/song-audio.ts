/**
 * 真实音乐素材的接线：预览走加载器、导出走解码器，两边取的是同一份字节。
 *
 * 素材不进仓库（`.gitignore` 里 `examples/browser/assets/`），示例按相对路径读取；
 * 缺文件时不静默降级成「没声音的视频」，而是抛出可读的错误，由调用方在 HUD 上说明。
 */
import type { AudioDecoder, AudioBufferLoader } from "@lingfan-video/infra";

/** 素材相对路径（Vite 以 `examples/browser` 为根） */
export const SONG_URL = "/assets/song.mp3";

/** 素材时长（毫秒）：用于在 HUD/时间线上给出确定的口径，不参与采样。 */
export const SONG_DURATION_MS = 134_298;

/** 加载原始字节：预览与导出共用，避免两条路径各读一次文件。 */
async function fetchSongBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`音频素材加载失败：${url}（HTTP ${res.status}）`);
  return await res.arrayBuffer();
}

/**
 * 预览端加载器：真素材用 `decodeAudioData`，其余 url 交给合成音源表。
 * 返回 `AudioBuffer` 之后由播放器转成流水线要的交错 PCM。
 */
export function makeSongLoader(
  ctx: AudioContext,
  synth: AudioBufferLoader,
): AudioBufferLoader {
  const cache = new Map<string, Promise<AudioBuffer>>();
  return async (url: string): Promise<AudioBuffer> => {
    if (url !== SONG_URL) return synth(url);
    const hit = cache.get(url);
    if (hit) return hit;
    const pending = (async () => {
      const bytes = await fetchSongBytes(url);
      // 48kHz 素材：直接解到播放上下文，避免预览端再做一次重采样
      return await ctx.decodeAudioData(bytes.slice(0));
    })().catch((error: unknown) => {
      cache.delete(url);
      throw error;
    });
    cache.set(url, pending);
    return pending;
  };
}

/**
 * 导出端解码器：真素材用 `OfflineAudioContext` 解码（浏览器里导出，不依赖 AudioContext 实时状态），
 * 其余 url 交给合成音源解码器；输出交错 Float32，与预览端同一份样本。
 */
export function makeSongDecoder(
  synth: AudioDecoder,
  sampleRate = 48_000,
): AudioDecoder {
  const cache = new Map<string, Float32Array>();
  return {
    async decode(clip) {
      if (clip.url !== SONG_URL) return synth.decode(clip);
      const cached = cache.get(clip.url);
      if (cached) {
        return {
          clip,
          sampleRate,
          channels: 2,
          durationMs: (cached.length / 2 / sampleRate) * 1000,
          data: cached,
        };
      }
      const bytes = await fetchSongBytes(clip.url);
      const offline = new OfflineAudioContext(2, 1, sampleRate);
      const buffer = await offline.decodeAudioData(bytes);
      const frames = buffer.length;
      const channels = Math.min(2, buffer.numberOfChannels);
      const data = new Float32Array(frames * 2);
      const left = buffer.getChannelData(0);
      const right = channels > 1 ? buffer.getChannelData(1) : left;
      for (let i = 0; i < frames; i += 1) {
        data[i * 2] = left[i]!;
        data[i * 2 + 1] = right[i]!;
      }
      cache.set(clip.url, data);
      return {
        clip,
        sampleRate,
        channels: 2,
        durationMs: (frames / sampleRate) * 1000,
        data,
      };
    },
  };
}
