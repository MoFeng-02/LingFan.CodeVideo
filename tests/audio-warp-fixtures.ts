/** audio-warp 系列测试的共用夹具：斜坡 PCM、离线混音器、声音构造与声道读取。 */
import { clip, gain as gainOf } from "@lingfan-video/core";
import { OfflineAudioMixer } from "@lingfan-video/infra";
import type { DecodedPcm } from "@lingfan-video/infra";
import type { AudioVoice, Ms } from "@lingfan-video/contracts";

export const OUT_RATE = 48_000;

/** 合成 PCM：值为帧号（递增斜坡），便于逐样本断言源位置 */
export function rampPcm(ms: number, channels = 1): DecodedPcm {
  const frames = Math.round((ms / 1000) * OUT_RATE);
  const data = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++)
    for (let ch = 0; ch < channels; ch++) data[f * channels + ch] = f;
  return {
    clip: clip("ramp"),
    sampleRate: OUT_RATE,
    channels,
    durationMs: ms,
    data,
  };
}

export function makeMixer(pcm: DecodedPcm) {
  const decoder = {
    async decode() {
      return pcm;
    },
  };
  return new OfflineAudioMixer(decoder, {
    sampleRate: OUT_RATE,
    channels: 2,
  });
}

export function voice(startMs: Ms, extra?: Partial<AudioVoice>): AudioVoice {
  return {
    id: "v",
    clip: clip("ramp"),
    startMs,
    gain: gainOf(1),
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    ...extra,
  };
}

/** 输出缓冲第 frame 帧的左声道（交错布局） */
export function left(data: Float32Array, frame: number, channels = 2): number {
  return data[frame * channels]!;
}
