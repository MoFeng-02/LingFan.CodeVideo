/** 轨道容器：把样本表与媒体头组装成 trak（tkhd + mdia/minf/stbl）。 */
import { box, fourcc, textOf, u16, u32, zeros } from "../boxes";
import type {
  AudioChunkSpec,
  AudioTrackSpec,
  TrackLayout,
  VideoChunkSpec,
  VideoTrackSpec,
} from "./chunks";
import {
  MOVIE_TIMESCALE,
  makeDref,
  makeMdhd,
  makeStsd,
  makeTkhd,
} from "./headers";
import {
  audioSampleEntry,
  makeStco,
  makeStsc,
  makeStss,
  makeStsz,
  makeStts,
  videoSampleEntry,
} from "./tables";

function videoTrak(
  spec: VideoTrackSpec,
  chunks: VideoChunkSpec[],
  layout: TrackLayout,
  durationMs: number,
): Uint8Array {
  const sttsEntries: Array<[number, number]> = [];
  for (const c of chunks) {
    const d = Math.round(c.durationUs / 1000);
    const last = sttsEntries[sttsEntries.length - 1];
    if (last && last[1] === d) last[0]++;
    else sttsEntries.push([1, d]);
  }
  const stbl = box(
    "stbl",
    makeStsd(videoSampleEntry(spec)),
    makeStts(sttsEntries),
    makeStsc(chunks.length),
    makeStsz(chunks.map((c) => c.data.length)),
    makeStco([layout.chunkOffset], chunks.length > 0),
    makeStss(chunks),
  );
  return makeTrak(
    1,
    durationMs,
    spec.width,
    spec.height,
    0,
    makeMdhd(MOVIE_TIMESCALE, Math.ceil(durationMs)),
    "vide",
    box("vmhd", u32(1), u16(0), u16(0), u16(0), u16(0)),
    stbl,
  );
}

function audioTrak(
  spec: AudioTrackSpec,
  chunks: AudioChunkSpec[],
  layout: TrackLayout,
  totalSamples: number,
  durationMs: number,
): Uint8Array {
  const sttsEntries: Array<[number, number]> = [];
  for (const c of chunks) {
    const d = Math.max(1, Math.round((c.durationUs / 1e6) * spec.sampleRate));
    const last = sttsEntries[sttsEntries.length - 1];
    if (last && last[1] === d) last[0]++;
    else sttsEntries.push([1, d]);
  }
  const stbl = box(
    "stbl",
    makeStsd(audioSampleEntry(spec)),
    makeStts(sttsEntries),
    makeStsc(chunks.length),
    makeStsz(chunks.map((c) => c.data.length)),
    makeStco([layout.chunkOffset], chunks.length > 0),
  );
  return makeTrak(
    2,
    durationMs,
    0,
    0,
    0x0100,
    makeMdhd(spec.sampleRate, totalSamples),
    "soun",
    box("smhd", u32(0), u16(0), u16(0)),
    stbl,
  );
}

function makeTrak(
  trackId: number,
  durationMs: number,
  width: number,
  height: number,
  volume: number,
  mdhd: Uint8Array,
  handler: string,
  mediaHeader: Uint8Array,
  stbl: Uint8Array,
): Uint8Array {
  return box(
    "trak",
    makeTkhd(trackId, durationMs, width, height, volume),
    box(
      "mdia",
      mdhd,
      box("hdlr", u32(0), u32(0), fourcc(handler), zeros(12), textOf("")),
      box("minf", mediaHeader, box("dinf", makeDref()), stbl),
    ),
  );
}

export { audioTrak, makeTrak, videoTrak };
