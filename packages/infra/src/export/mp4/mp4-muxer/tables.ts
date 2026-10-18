/** 样本表与样本条目：stsd/stts/stsc/stsz/stco/stss 的构造。 */
import { box, fixed1616, u16, u32, zeros } from "../boxes";
import { makeEsds } from "../aac";
import type {
  AudioChunkSpec,
  AudioTrackSpec,
  VideoChunkSpec,
  VideoTrackSpec,
} from "./chunks";

/** avc1 视觉样本条目：avcC 携带解码参数集 */
function videoSampleEntry(spec: VideoTrackSpec): Uint8Array {
  return box(
    "avc1",
    zeros(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    zeros(12), // pre_defined
    u16(spec.width),
    u16(spec.height),
    u32(0x0048_0000), // 72dpi
    u32(0x0048_0000),
    u32(0), // reserved
    u16(1), // frame_count
    zeros(32), // compressorname
    u16(24), // depth
    u16(0xffff), // pre_defined
    box("avcC", spec.avcC),
  );
}

/** mp4a 音频样本条目：esds 携带 ASC，采样率为 16.16 定点 */
function audioSampleEntry(spec: AudioTrackSpec): Uint8Array {
  return box(
    "mp4a",
    zeros(6), // reserved
    u16(1), // data_reference_index
    u16(0), // version
    u16(0), // revision
    u32(0), // vendor
    u16(spec.channels),
    u16(16), // sample size
    u16(0), // pre_defined
    u16(0), // reserved
    fixed1616(spec.sampleRate),
    makeEsds(spec.asc, spec.bitrate),
  );
}

function makeStts(entries: Array<[number, number]>): Uint8Array {
  return box(
    "stts",
    u32(0),
    u32(entries.length),
    ...entries.flatMap(([n, d]) => [u32(n), u32(d)]),
  );
}

/** stsc：样本 → chunk 映射（本例每轨单 chunk） */
function makeStsc(sampleCount: number): Uint8Array {
  if (sampleCount <= 0) return box("stsc", u32(0), u32(0));
  return box("stsc", u32(0), u32(1), u32(1), u32(sampleCount), u32(1));
}

function makeStsz(sizes: number[]): Uint8Array {
  return box("stsz", u32(0), u32(0), u32(sizes.length), ...sizes.map(u32));
}

/** stco：chunk 数据在文件中的绝对偏移 */
function makeStco(offsets: number[], hasChunks: boolean): Uint8Array {
  if (!hasChunks) return box("stco", u32(0), u32(0));
  return box("stco", u32(0), u32(offsets.length), ...offsets.map(u32));
}

/** stss：同步样本（关键帧）索引，1 基 */
function makeStss(chunks: VideoChunkSpec[]): Uint8Array {
  const keys = chunks
    .map((c, i) => (c.keyFrame ? i + 1 : 0))
    .filter((v) => v > 0);
  return box("stss", u32(0), u32(keys.length), ...keys.map(u32));
}

/** 音频总采样数（stts 各帧时长之和，换算到采样率刻度） */
function audioSampleCount(
  chunks: AudioChunkSpec[],
  sampleRate: number,
): number {
  return chunks.reduce(
    (s, c) => s + Math.max(1, Math.round((c.durationUs / 1e6) * sampleRate)),
    0,
  );
}

export {
  audioSampleCount,
  audioSampleEntry,
  makeStco,
  makeStsc,
  makeStss,
  makeStsz,
  makeStts,
  videoSampleEntry,
};
