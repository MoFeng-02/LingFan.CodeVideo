/**
 * moov 内各层容器头：mvhd / tkhd / mdhd 与数据引用。
 *
 * 统一约定：电影时间刻度取 1000（毫秒），与时间线同刻度，避免帧率相关的取整
 * 误差；样本层的时间刻度则是编码块原生的微秒/采样率刻度。这两个刻度由
 * `mvhd`/`tkhd` 分别声明，播放器据此换算，所以容器里不做跨刻度取整。
 */
import { box, concat, fixed1616, u16, u32, zeros } from "../boxes";

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

export {
  MATRIX,
  MOVIE_TIMESCALE,
  makeDref,
  makeMdhd,
  makeMvhd,
  makeStsd,
  makeTkhd,
};
