/**
 * 最小 MP4 封装：ftyp + moov（视频轨 + 可选音频轨）+ 单 mdat。
 * 不生成 fMP4：普通 mp4 文件即可被浏览器 <video> 与常见播放器打开。
 * 音频样本按 AAC 帧写入（每帧一个 sample），视频/音频各自成单 chunk，
 * mdat 内先视频后音频（非交错——最小封装，播放器顺序读取即可）。
 */
import { box, concat, fourcc, toArrayBuffer, u32 } from "../boxes";
import type {
  AudioChunkSpec,
  AudioTrackSpec,
  TrackLayout,
  VideoChunkSpec,
  VideoTrackSpec,
} from "./chunks";
import { makeMvhd } from "./headers";
import { audioSampleCount } from "./tables";
import { audioTrak, videoTrak } from "./tracks";

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
