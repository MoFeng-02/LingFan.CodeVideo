/**
 * 预览用合成音频资产：不依赖外部文件，全部按确定性公式生成（循环无缝、可复现）。
 * 供 WebAudioPlayer 的 loader 使用；导出端真实资产走解码器，两者语义一致（样本=时间线纯函数）。
 */
import type { AudioDecoder } from "@lingfan-video/infra";

export interface SynthClipSpec {
  url: string;
  durationMs: number;
  channels: number;
  /** 逐帧采样函数（sample 索引 → [-1,1] 振幅） */
  sample(frame: number, ch: number, sampleRate: number): number;
}

const CLIPS: SynthClipSpec[] = [
  {
    // 温暖和弦铺底：全部频率在时长内整数周期完成 → 循环无缝
    url: "pad",
    durationMs: 2000,
    channels: 2,
    sample(frame, ch, rate) {
      const t = frame / rate;
      const detune = ch === 0 ? 0 : 1.5; // 左右微失谐制造立体声宽度
      const a = 0.16 * Math.sin(2 * Math.PI * (110 + detune) * t);
      const b = 0.12 * Math.sin(2 * Math.PI * (165 + detune) * t);
      const c = 0.09 * Math.sin(2 * Math.PI * (220 + detune) * t);
      const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * t); // 1Hz 呼吸
      return (a + b + c) * lfo;
    },
  },
  {
    // 短促提示音：880Hz 指数衰减（单声道源 → 双声道输出可测「复制」）
    url: "blip",
    durationMs: 260,
    channels: 1,
    sample(frame, _ch, rate) {
      const t = frame / rate;
      return 0.55 * Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t * 14);
    },
  },
  {
    // 节拍器：1 秒 4 击（250ms 一格 = 120BPM），击点为 1200Hz 指数衰减，循环无缝。
    // 变速时密度与音高同时变化——用来听「加速/恢复」是否与时间线一致。
    url: "tick",
    durationMs: 1000,
    channels: 2,
    sample(frame, _ch, rate) {
      const beatMs = 250;
      const ms = (frame / rate) * 1000;
      const phase = ms % beatMs;
      const t = phase / 1000;
      return 0.5 * Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-t * 60);
    },
  },
  {
    // 扫频噪声：确定性的伪随机噪声（LCG）+ 包络，模拟转场风声
    url: "whoosh",
    durationMs: 700,
    channels: 2,
    sample(frame, ch, rate) {
      const t = frame / rate;
      const env = Math.sin((Math.PI * frame) / (0.7 * rate)); // 平滑升降
      let seed = (frame * 1103515245 + (ch + 1) * 12345) >>> 0;
      seed = (seed * 1103515245 + 12345) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      const sweep = Math.sin(2 * Math.PI * (300 + 1800 * t) * t);
      return 0.18 * env * (0.6 * noise + 0.4 * sweep);
    },
  },
];

/** 生成 AudioBuffer（惰性：首次 load 时才建缓冲） */
export function makeSynthLoader(ctx: AudioContext) {
  const cache = new Map<string, AudioBuffer>();
  return async (url: string): Promise<AudioBuffer> => {
    const hit = cache.get(url);
    if (hit) return hit;
    const spec = CLIPS.find((c) => c.url === url);
    if (!spec)
      throw new Error(
        `synth loader：未登记的音源 '${url}'（示例只内置 pad/blip/tick/whoosh）`,
      );
    const frames = Math.round((spec.durationMs / 1000) * ctx.sampleRate);
    const buffer = ctx.createBuffer(spec.channels, frames, ctx.sampleRate);
    for (let ch = 0; ch < spec.channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let f = 0; f < frames; f++)
        data[f] = spec.sample(f, ch, ctx.sampleRate);
    }
    cache.set(url, buffer);
    return buffer;
  };
}

/**
 * 导出端解码器：与预览共用同一批合成音源公式，直接产出交错 Float32 PCM（不经 AudioContext）。
 * 预览用 makeSynthLoader → AudioBuffer，导出用本函数 → OfflineAudioMixer；样本公式是同一份，
 * 因此「预览听到的」与「导出得到的」是同一段音频。
 */
export function makeSynthDecoder(sampleRate = 48_000): AudioDecoder {
  const cache = new Map<string, Float32Array>();
  return {
    async decode(clip) {
      const spec = CLIPS.find((c) => c.url === clip.url);
      if (!spec)
        throw new Error(
          `synth decoder：未登记的音源 '${clip.url}'（示例内置 pad/blip/tick/whoosh）`,
        );
      const frames = Math.round((spec.durationMs / 1000) * sampleRate);
      let data = cache.get(spec.url);
      if (!data) {
        data = new Float32Array(frames * spec.channels);
        for (let ch = 0; ch < spec.channels; ch += 1)
          for (let f = 0; f < frames; f += 1)
            data[f * spec.channels + ch] = spec.sample(f, ch, sampleRate);
        cache.set(spec.url, data);
      }
      return {
        clip,
        sampleRate,
        channels: spec.channels,
        durationMs: spec.durationMs,
        data,
      };
    },
  };
}
