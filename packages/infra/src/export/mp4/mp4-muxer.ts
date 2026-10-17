/**
 * 最小 MP4 封装：ftyp + moov（视频轨 + 可选音频轨）+ 单 mdat。
 * 不生成 fMP4：普通 mp4 文件即可被浏览器 <video> 与常见播放器打开。
 * 音频样本按 AAC 帧写入（每帧一个 sample），视频/音频各自成单 chunk，
 * mdat 内先视频后音频（非交错——最小封装，播放器顺序读取即可）。
 */
import {
  box,
  concat,
  fixed1616,
  fourcc,
  textOf,
  toArrayBuffer,
  u16,
  u32,
  zeros,
} from "./boxes";
import { makeEsds } from "./aac";

/** 电影时间刻度：毫秒（与时间线同刻度，避免帧率相关的取整） */
const MOVIE_TIMESCALE = 1000;
/** 单位矩阵（tkhd/mvhd 的 display matrix） */
const MATRIX = concat([
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x0001_0000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x4000_0000),
]);

/** 一个已编码视频帧（时间为微秒，与 WebCodecs 一致） */
export interface VideoChunkSpec {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
  keyFrame: boolean;
}

/** 一个已编码音频帧（AAC-LC 原始帧，不含 ADTS 头） */
export interface AudioChunkSpec {
  data: Uint8Array;
  /** 该帧覆盖的时长（微秒）；写入 stts 时换算成采样率刻度 */
  durationUs: number;
}

/** 视频轨声明 */
export interface VideoTrackSpec {
  width: number;
  height: number;
  /** 解码器配置（avcC 负载，SPS/PPS） */
  avcC: Uint8Array;
}

/** 音频轨声明 */
export interface AudioTrackSpec {
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig */
  asc: Uint8Array;
  /** 名义码率（bps），仅写入 esds 元数据 */
  bitrate: number;
}

interface TrackLayout {
  chunkOffset: number;
  chunkCount: number;
}

/** MP4 封装器：按帧塞入已编码数据，finalize 生成文件 */
export class Mp4Muxer {
  private readonly video: VideoChunkSpec[] = [];
  private readonly audio: AudioChunkSpec[] = [];

  addVideo(chunk: VideoChunkSpec): void {
    this.video.push(chunk);
  }

  addAudio(chunk: AudioChunkSpec): void {
    this.audio.push(chunk);
  }

  /** 视频帧数（未编码则为 0） */
  get videoCount(): number {
    return this.video.length;
  }

  /** 音频帧数（未编码则为 0） */
  get audioCount(): number {
    return this.audio.length;
  }

  finalize(video: VideoTrackSpec, audio?: AudioTrackSpec): Blob {
    const ftyp = makeFtyp();
    const hasAudio = audio !== undefined && this.audio.length > 0;
    // moov 内 stco 的偏移值长度固定：先以占位偏移量算一次尺寸，再回填真实偏移。
    const measure = makeMoov(
      video,
      this.video,
      hasAudio ? audio : undefined,
      this.audio,
      { chunkOffset: 0, chunkCount: 0 },
      { chunkOffset: 0, chunkCount: 0 },
    );
    const dataStart = ftyp.length + measure.length + 8;
    const videoBytes = this.video.reduce((s, c) => s + c.data.length, 0);
    const videoLayout: TrackLayout = { chunkOffset: dataStart, chunkCount: 1 };
    const audioLayout: TrackLayout = {
      chunkOffset: dataStart + videoBytes,
      chunkCount: 1,
    };
    const moov = makeMoov(
      video,
      this.video,
      hasAudio ? audio : undefined,
      this.audio,
      videoLayout,
      audioLayout,
    );
    const payload = concat([
      ...this.video.map((c) => c.data),
      ...this.audio.map((c) => c.data),
    ]);
    const mdat = box("mdat", payload);
    return new Blob(
      [toArrayBuffer(ftyp), toArrayBuffer(moov), toArrayBuffer(mdat)],
      { type: "video/mp4" },
    );
  }
}

function makeFtyp(): Uint8Array {
  return box(
    "ftyp",
    fourcc("isom"),
    u32(512),
    concat([fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41")]),
  );
}

function makeMoov(
  video: VideoTrackSpec,
  videoChunks: VideoChunkSpec[],
  audio: AudioTrackSpec | undefined,
  audioChunks: AudioChunkSpec[],
  videoLayout: TrackLayout,
  audioLayout: TrackLayout,
): Uint8Array {
  const videoEndMs = videoChunks.length
    ? (videoChunks[videoChunks.length - 1]!.timestampUs +
        videoChunks[videoChunks.length - 1]!.durationUs) /
      1000
    : 0;
  const audioSamples = audio
    ? audioSampleCount(audioChunks, audio.sampleRate)
    : 0;
  const audioEndMs = audio ? (audioSamples / audio.sampleRate) * 1000 : 0;
  const durationMs = Math.max(videoEndMs, audioEndMs);
  const tracks: Uint8Array[] = [
    videoTrak(video, videoChunks, videoLayout, durationMs),
  ];
  if (audio && audioChunks.length > 0) {
    tracks.push(
      audioTrak(audio, audioChunks, audioLayout, audioSamples, durationMs),
    );
  }
  return box("moov", makeMvhd(durationMs, tracks.length), ...tracks);
}

/** mvhd：整段时长 = 视频末点与音频时长取大（两者必须同长，短者由播放器补静音） */
function makeMvhd(durationMs: number, trackCount: number): Uint8Array {
  return box(
    "mvhd",
    u32(0), // version + flags
    u32(0), // creation_time
    u32(0), // modification_time
    u32(MOVIE_TIMESCALE),
    u32(Math.ceil(durationMs)),
    u32(0x0001_0000), // rate
    u16(0x0100), // volume（1.0）
    u16(0), // reserved
    zeros(8), // reserved
    MATRIX,
    zeros(24), // pre_defined
    u32(trackCount + 1), // next_track_ID
  );
}

/** tkhd：轨道头（flags=7 = enabled | in movie | in preview） */
function makeTkhd(
  trackId: number,
  durationMs: number,
  width: number,
  height: number,
  volume: number,
): Uint8Array {
  return box(
    "tkhd",
    u32(0x0000_0007),
    u32(0), // creation_time
    u32(0), // modification_time
    u32(trackId),
    u32(0), // reserved
    u32(Math.ceil(durationMs)),
    zeros(8), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(volume), // volume（视频 0 / 音频 1.0）
    u16(0), // reserved
    MATRIX,
    fixed1616(width),
    fixed1616(height),
  );
}

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

/** mdhd：媒体时间刻度与时长（视频用毫秒刻度，音频用采样率刻度） */
function makeMdhd(timescale: number, duration: number): Uint8Array {
  return box(
    "mdhd",
    u32(0),
    u32(0),
    u32(0),
    u32(timescale),
    u32(Math.ceil(duration)),
    u16(0x55c4), // language：und
    u16(0),
  );
}

/** dref：全部样本数据位于本文件（data reference = self） */
function makeDref(): Uint8Array {
  return box(
    "dref",
    u32(0),
    u32(1),
    box("url ", u32(1)), // flags=1：数据在本文件内
  );
}

function makeStsd(entry: Uint8Array): Uint8Array {
  return box("stsd", u32(0), u32(1), entry);
}

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
