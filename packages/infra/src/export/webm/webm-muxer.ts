/**
 * WebM 容器装配：把已编码的块拼成可播放的 `.webm` 字节。
 *
 * 只做容器，不碰编码器：调用方先 `addVideo` / `addAudio` 追加编码块，`finalize`
 * 时一次性拼出文件。装配顺序是 EBML 头 → 段（段信息 + 轨道表 + 各簇 + 索引表），
 * 索引表放最后，因为它要引用每个簇在段负载里的字节偏移。
 *
 * 两个容器侧的硬约束决定了这里的结构：
 * - 块时间码是**相对簇时间码的有符号 16 位**偏移，所以簇跨度必须留在 ±32.7 秒内，
 *   本模块按关键帧与 30 秒两个条件切簇；
 * - 索引点必须落在关键帧上，所以只在簇以关键帧开头时写索引。
 *
 * 尺寸全部已知（不是流式写入），因此段长度与索引偏移都在内存里算准再写。
 */
import type { Bytes } from "./ebml";
import { concatBytes, element, stringElement, uintElement } from "./ebml";
import {
  ALPHA_MODE,
  AUDIO,
  BIT_DEPTH,
  CHANNELS,
  CODEC_ID,
  CODEC_PRIVATE,
  CUES,
  CUE_CLUSTER_POSITION,
  CUE_POINT,
  CUE_TIME,
  CUE_TRACK,
  CUE_TRACK_POSITIONS,
  DEFAULT_DURATION,
  DOC_TYPE,
  DOC_TYPE_READ_VERSION,
  DOC_TYPE_VERSION,
  DURATION,
  EBML,
  EBML_MAX_ID_LENGTH,
  EBML_MAX_SIZE_LENGTH,
  EBML_READ_VERSION,
  EBML_VERSION,
  INFO,
  MUXING_APP,
  PIXEL_HEIGHT,
  PIXEL_WIDTH,
  SAMPLING_FREQUENCY,
  SEGMENT,
  TIMECODE_SCALE,
  TRACKS,
  TRACK_ENTRY,
  TRACK_NUMBER,
  TRACK_TYPE,
  TRACK_UID,
  VIDEO,
  WRITING_APP,
} from "./ids";
import { cluster, type ClusterBlock } from "./blocks";
import {
  WEBM_TIMECODE_SCALE_NS,
  type WebmAudioChunk,
  type WebmAudioSpec,
  type WebmVideoChunk,
  type WebmVideoSpec,
} from "./types";

/** 视频轨编号：块里的轨道指针，固定给视频 */
const VIDEO_TRACK = 1;
/** 音频轨编号：块里的轨道指针，固定给音频 */
const AUDIO_TRACK = 2;
/** 单个簇的最大跨度（毫秒）：必须小于块相对时间码的 ±32.7 秒上限 */
const CLUSTER_SPAN_MS = 30_000;
/** 封装程序标识 */
const MUXING_APP_NAME = "LingFan CodeVideo";
/** 轨道类型取值：视频 */
const TRACK_TYPE_VIDEO = 1;
/** 轨道类型取值：音频 */
const TRACK_TYPE_AUDIO = 2;
/** 本模块写出的 EBML 文档类型版本 */
const DOC_TYPE_VERSION_VALUE = 4;
/** 本模块写出/要求的最低读取版本 */
const DOC_TYPE_READ_VERSION_VALUE = 2;

/** 一个待写出的簇：时间码与块列表 */
interface PlannedCluster {
  /** 簇时间码（毫秒，绝对时刻） */
  readonly timecodeMs: number;
  /** 簇内块，按相对时间码升序 */
  readonly blocks: readonly ClusterBlock[];
  /** 本簇是否以视频关键帧开头（决定能否写索引点） */
  readonly seekable: boolean;
}

/** WebM 容器写入器：追加编码块，收尾时一次拼出文件字节 */
export class WebmMuxer {
  /** 已追加的视频块（按追加顺序，时间戳单调不减由调用方保证） */
  private readonly videoChunks: WebmVideoChunk[] = [];
  /** 已追加的音频块 */
  private readonly audioChunks: WebmAudioChunk[] = [];

  /** 已追加的视频块数 */
  get videoCount(): number {
    return this.videoChunks.length;
  }

  /** 已追加的音频块数 */
  get audioCount(): number {
    return this.audioChunks.length;
  }

  /**
   * 追加一个已编码视频块。
   *
   * @param chunk 编码字节、时间戳与是否关键帧
   */
  addVideo(chunk: WebmVideoChunk): void {
    this.videoChunks.push(chunk);
  }

  /**
   * 追加一个已编码音频块。
   *
   * @param chunk 编码字节与时间戳
   */
  addAudio(chunk: WebmAudioChunk): void {
    this.audioChunks.push(chunk);
  }

  /**
   * 拼出完整的 `.webm` 字节。
   *
   * 至少要有视频块：没有画面的容器没有意义，调用方应在收尾前自行检查。
   *
   * @param video 视频轨声明（尺寸、编解码器、是否带 alpha 附加块）
   * @param audio 音频轨声明；省略则产物只有视频轨
   * @param durationMs 时长（毫秒）；省略时按最后一个块的结束时刻推算
   * @returns 完整文件字节
   */
  finalize(
    video: WebmVideoSpec,
    audio?: WebmAudioSpec,
    durationMs?: number,
  ): Bytes {
    if (this.videoChunks.length === 0)
      throw new Error("WebmMuxer：没有视频块（finalize 前需追加帧）");
    /** 段信息：时间刻度、时长与封装程序标识 */
    const info = this.infoElement(durationMs ?? this.computeDurationMs());
    /** 轨道表：视频轨 + 可选音频轨 */
    const tracks = this.tracksElement(video, audio);
    /** 切好的簇（按关键帧与跨度上限分段） */
    const planned = this.planClusters();
    /** 段负载里的子元素，边写边累计偏移（索引要引用簇的字节位置） */
    const parts: Uint8Array[] = [info, tracks];
    /** 当前已累计的段负载字节数（即下一个簇的起始偏移） */
    let offset = info.length + tracks.length;
    /** 索引点：簇时间码 + 该簇在段负载内的偏移 */
    const cuePoints: { timeMs: number; position: number }[] = [];
    for (const item of planned) {
      /** 本簇的完整字节 */
      const bytes = cluster(item.timecodeMs, item.blocks);
      if (item.seekable)
        cuePoints.push({ timeMs: item.timecodeMs, position: offset });
      parts.push(bytes);
      offset += bytes.length;
    }
    if (cuePoints.length > 0) parts.push(this.cuesElement(cuePoints));
    /** 段：负载是上面全部子元素的拼接 */
    const segment = element(SEGMENT, concatBytes(parts));
    return concatBytes([this.headerElement(), segment]);
  }

  /** EBML 头：声明这是 `webm` 文档，并给出本模块写出的元素长度上限 */
  private headerElement(): Bytes {
    return element(
      EBML,
      concatBytes([
        uintElement(EBML_VERSION, DOC_TYPE_VERSION_VALUE),
        uintElement(EBML_READ_VERSION, DOC_TYPE_READ_VERSION_VALUE),
        uintElement(EBML_MAX_ID_LENGTH, 4),
        uintElement(EBML_MAX_SIZE_LENGTH, 8),
        stringElement(DOC_TYPE, "webm"),
        uintElement(DOC_TYPE_VERSION, DOC_TYPE_VERSION_VALUE),
        uintElement(DOC_TYPE_READ_VERSION, DOC_TYPE_READ_VERSION_VALUE),
      ]),
    );
  }

  /**
   * 段信息：时间刻度、时长与封装程序标识。
   *
   * 时间刻度固定 1 毫秒——块时间戳以微秒给出，除以 1000 落成毫秒正好整除到
   * 播放器常用精度，避免浮点时长带来的末帧误差。
   *
   * @param durationMs 影片时长（毫秒）
   */
  private infoElement(durationMs: number): Bytes {
    return element(
      INFO,
      concatBytes([
        uintElement(TIMECODE_SCALE, WEBM_TIMECODE_SCALE_NS),
        element(DURATION, floatPayload(durationMs)),
        stringElement(MUXING_APP, MUXING_APP_NAME),
        stringElement(WRITING_APP, MUXING_APP_NAME),
      ]),
    );
  }

  /**
   * 轨道表：视频轨必备，音频轨按需追加。
   *
   * @param video 视频轨声明
   * @param audio 音频轨声明；省略则不写音频轨
   */
  private tracksElement(video: WebmVideoSpec, audio?: WebmAudioSpec): Bytes {
    /** 视频轨子元素：编号/类型/编解码器 + 画面参数 */
    const videoEntry = element(
      TRACK_ENTRY,
      concatBytes([
        uintElement(TRACK_NUMBER, VIDEO_TRACK),
        uintElement(TRACK_UID, VIDEO_TRACK),
        uintElement(TRACK_TYPE, TRACK_TYPE_VIDEO),
        stringElement(CODEC_ID, video.codec),
        ...(video.defaultDurationNs === undefined
          ? []
          : [uintElement(DEFAULT_DURATION, video.defaultDurationNs)]),
        element(
          VIDEO,
          concatBytes([
            uintElement(PIXEL_WIDTH, video.width),
            uintElement(PIXEL_HEIGHT, video.height),
            // 声明这一轨带 alpha 附加块：播放器据此去读 BlockAdditional
            ...(video.alpha ? [uintElement(ALPHA_MODE, 1)] : []),
          ]),
        ),
      ]),
    );
    if (!audio) return element(TRACKS, videoEntry);
    /** 音频轨子元素：编号/类型/编解码器 + 采样参数 */
    const audioEntry = element(
      TRACK_ENTRY,
      concatBytes([
        uintElement(TRACK_NUMBER, AUDIO_TRACK),
        uintElement(TRACK_UID, AUDIO_TRACK),
        uintElement(TRACK_TYPE, TRACK_TYPE_AUDIO),
        stringElement(CODEC_ID, "A_OPUS"),
        element(CODEC_PRIVATE, audio.codecPrivate),
        element(
          AUDIO,
          concatBytes([
            element(SAMPLING_FREQUENCY, floatPayload(audio.sampleRate)),
            uintElement(CHANNELS, audio.channels),
            uintElement(BIT_DEPTH, 32),
          ]),
        ),
      ]),
    );
    return element(TRACKS, concatBytes([videoEntry, audioEntry]));
  }

  /**
   * 索引表：每个可跳转的簇一条，指向它的时间码与段内偏移。
   *
   * @param points 索引点（时间码 + 段负载偏移）
   */
  private cuesElement(
    points: readonly { timeMs: number; position: number }[],
  ): Bytes {
    /** 索引点元素：时间码 + 视频轨在簇内的位置 */
    const children = points.map((point) =>
      element(
        CUE_POINT,
        concatBytes([
          uintElement(CUE_TIME, point.timeMs),
          element(
            CUE_TRACK_POSITIONS,
            concatBytes([
              uintElement(CUE_TRACK, VIDEO_TRACK),
              uintElement(CUE_CLUSTER_POSITION, point.position),
            ]),
          ),
        ]),
      ),
    );
    return element(CUES, concatBytes(children));
  }

  /** 把两轨的块按时间排序并切成簇（关键帧开头 + 跨度上限两个切点） */
  private planClusters(): PlannedCluster[] {
    /** 两轨合并后的块，按时间戳升序（同刻视频在前，索引才落在画面上） */
    const merged: {
      track: number;
      timecodeMs: number;
      block: ClusterBlock;
      keyFrame: boolean;
    }[] = [];
    for (const chunk of this.videoChunks) {
      merged.push({
        track: VIDEO_TRACK,
        timecodeMs: Math.round(chunk.timestampUs / 1000),
        keyFrame: chunk.keyFrame,
        block: {
          trackNumber: VIDEO_TRACK,
          relativeMs: 0,
          keyFrame: chunk.keyFrame,
          data: chunk.data,
          ...(chunk.alpha ? { alpha: chunk.alpha } : {}),
        },
      });
    }
    for (const chunk of this.audioChunks) {
      merged.push({
        track: AUDIO_TRACK,
        timecodeMs: Math.round(chunk.timestampUs / 1000),
        keyFrame: true,
        block: {
          trackNumber: AUDIO_TRACK,
          relativeMs: 0,
          keyFrame: true,
          data: chunk.data,
        },
      });
    }
    merged.sort((a, b) => a.timecodeMs - b.timecodeMs || a.track - b.track);
    /** 已切好的簇 */
    const clusters: PlannedCluster[] = [];
    /** 正在累积的簇 */
    let current: {
      timecodeMs: number;
      blocks: ClusterBlock[];
      seekable: boolean;
    } | null = null;
    for (const item of merged) {
      /** 是否要在此开新簇：首个块、视频关键帧、或跨度将超出上限 */
      if (current === null) {
        current = {
          timecodeMs: item.timecodeMs,
          blocks: [],
          seekable: false,
        };
      } else if (
        (item.track === VIDEO_TRACK &&
          item.keyFrame &&
          current.blocks.length > 0) ||
        item.timecodeMs - current.timecodeMs > CLUSTER_SPAN_MS
      ) {
        clusters.push(current);
        current = {
          timecodeMs: item.timecodeMs,
          blocks: [],
          seekable: false,
        };
      }
      /** 相对簇时间码的偏移（簇内块的时间码基准） */
      const relativeMs = item.timecodeMs - current.timecodeMs;
      current.blocks.push({ ...item.block, relativeMs });
      if (item.track === VIDEO_TRACK && item.keyFrame && !current.seekable)
        current.seekable = true;
    }
    if (current) clusters.push(current);
    return clusters;
  }

  /** 时长：取所有块里最晚的结束时刻（毫秒） */
  private computeDurationMs(): number {
    /** 当前见过的最大结束时刻（微秒） */
    let endUs = 0;
    for (const chunk of this.videoChunks)
      endUs = Math.max(endUs, chunk.timestampUs + chunk.durationUs);
    for (const chunk of this.audioChunks)
      endUs = Math.max(endUs, chunk.timestampUs + chunk.durationUs);
    return Math.round(endUs / 1000);
  }
}

/** 8 字节双精度大端浮点负载（Matroska 的时长与采样率都是浮点） */
function floatPayload(value: number): Bytes {
  /** 8 字节缓冲 */
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}
