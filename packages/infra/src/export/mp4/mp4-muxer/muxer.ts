/**
 * 最小 MP4 封装：ftyp + moov（视频轨 + 可选音频轨）+ 单 mdat。
 * 不生成 fMP4：普通 mp4 文件即可被浏览器 <video> 与常见播放器打开。
 * 音频样本按 AAC 帧写入（每帧一个 sample），视频/音频各自成单 chunk，
 * mdat 内先视频后音频（非交错——最小封装，播放器顺序读取即可）。
 *
 * 使用顺序：逐帧 `addVideo` / `addAudio` 塞入已编码数据（本类只收集引用，
 * 不复制、不编码、不做背压控制），最后一次 `finalize` 给出 `Blob`。
 * 收齐之后再 `finalize` 才能得到正确时长与索引；`finalize` 可重复调用，
 * 每次都从已收集数据重新拼装，不会清空状态。
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
  /** 已收视频帧（按加入顺序，即显示顺序；时间由 `timestampUs` 给出） */
  private readonly video: VideoChunkSpec[] = [];
  /** 已收音频帧（按加入顺序；无音频时为空） */
  private readonly audio: AudioChunkSpec[] = [];

  /**
   * 加入一个已编码视频帧。
   *
   * 只保存引用，样本数据在 `finalize` 时才拼接，因此加入后不要再改
   * `data` 指向的缓冲。
   *
   * @param chunk 已编码帧；时间戳为微秒且应单调递增
   */
  addVideo(chunk: VideoChunkSpec): void {
    this.video.push(chunk);
  }

  /**
   * 加入一个已编码音频帧（AAC-LC 裸帧，不含 ADTS 头）。
   *
   * @param chunk 已编码音频帧；顺序即播放顺序
   */
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

  /**
   * 收尾并生成完整的 mp4 文件。
   *
   * 时长取视频末帧时间与音频采样总长两者较大值；给定音频轨但没有音频帧时
   * 不写音频轨（避免出现空轨）。
   *
   * @param video 视频轨声明（宽高、avcC）
   * @param audio 可选音频轨声明；缺省表示纯视频文件
   * @returns `video/mp4` 类型的 Blob（ftyp + moov + mdat）
   */
  finalize(video: VideoTrackSpec, audio?: AudioTrackSpec): Blob {
    /** 文件类型盒：isom 主品牌 + 兼容品牌列表 */
    const ftyp = makeFtyp();
    /** 实际是否需要音频轨：声明了音频轨且确实有音频帧 */
    const hasAudio = audio !== undefined && this.audio.length > 0;
    // moov 内 stco 的偏移值长度固定：先以占位偏移量算一次尺寸，再回填真实偏移。
    /** 占位 moov：用 0 偏移量测出 moov 的字节长度 */
    const measure = makeMoov(
      video,
      this.video,
      hasAudio ? audio : undefined,
      this.audio,
      { chunkOffset: 0, chunkCount: 0 },
      { chunkOffset: 0, chunkCount: 0 },
    );
    /** mdat 首个样本的偏移 = ftyp + moov + 8 字节 mdat 头 */
    const dataStart = ftyp.length + measure.length + 8;
    /** 视频样本总字节数（mdat 内视频段长度） */
    const videoBytes = this.video.reduce((s, c) => s + c.data.length, 0);
    /** 视频轨 chunk 布局：单 chunk 从 mdat 负载起点开始 */
    const videoLayout: TrackLayout = { chunkOffset: dataStart, chunkCount: 1 };
    /** 音频轨 chunk 布局：紧随视频段之后，同样单 chunk */
    const audioLayout: TrackLayout = {
      chunkOffset: dataStart + videoBytes,
      chunkCount: 1,
    };
    /** 最终 moov：与占位版本等长，偏移量已填真实值 */
    const moov = makeMoov(
      video,
      this.video,
      hasAudio ? audio : undefined,
      this.audio,
      videoLayout,
      audioLayout,
    );
    /** mdat 负载：先全部视频样本、再全部音频样本（非交错） */
    const payload = concat([
      ...this.video.map((c) => c.data),
      ...this.audio.map((c) => c.data),
    ]);
    /** 媒体数据盒：头 + 上述负载 */
    const mdat = box("mdat", payload);
    return new Blob(
      [toArrayBuffer(ftyp), toArrayBuffer(moov), toArrayBuffer(mdat)],
      { type: "video/mp4" },
    );
  }
}

/**
 * 生成 ftyp 盒：主品牌 isom，版本 512，兼容 isom/iso2/avc1/mp41。
 *
 * @returns 完整 ftyp 盒字节
 */
function makeFtyp(): Uint8Array {
  return box(
    "ftyp",
    fourcc("isom"),
    u32(512),
    concat([fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41")]),
  );
}

/**
 * 生成 moov 盒：mvhd + 视频轨（+ 可选音频轨）。
 *
 * 时长在这里统一按毫秒算：视频取末帧时间戳加时长，音频取采样数除以采样率，
 * 两者取大，保证轨道声明的时长不短于实际内容。
 *
 * @param video 视频轨声明
 * @param videoChunks 视频样本列表（按显示顺序）
 * @param audio 音频轨声明；`undefined` 表示不写音频轨
 * @param audioChunks 音频样本列表
 * @param videoLayout 视频轨 chunk 布局
 * @param audioLayout 音频轨 chunk 布局
 * @returns 完整 moov 盒字节
 */
function makeMoov(
  video: VideoTrackSpec,
  videoChunks: VideoChunkSpec[],
  audio: AudioTrackSpec | undefined,
  audioChunks: AudioChunkSpec[],
  videoLayout: TrackLayout,
  audioLayout: TrackLayout,
): Uint8Array {
  /** 视频覆盖时长（毫秒）：末帧时间戳 + 末帧时长；无帧时为 0 */
  const videoEndMs = videoChunks.length
    ? (videoChunks[videoChunks.length - 1]!.timestampUs +
        videoChunks[videoChunks.length - 1]!.durationUs) /
      1000
    : 0;
  /** 音频样本总数（按采样率刻度折算） */
  const audioSamples = audio
    ? audioSampleCount(audioChunks, audio.sampleRate)
    : 0;
  /** 音频覆盖时长（毫秒）：样本总数 / 采样率 */
  const audioEndMs = audio ? (audioSamples / audio.sampleRate) * 1000 : 0;
  /** 整段时长（毫秒）：音视频覆盖范围的较大值 */
  const durationMs = Math.max(videoEndMs, audioEndMs);
  /** 轨道列表：视频轨必有，音频轨按声明与样本情况追加 */
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
