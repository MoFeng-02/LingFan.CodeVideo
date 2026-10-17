/**
 * MP4 封装与 AAC 声明：盒结构、chunk 偏移、时长刻度、音轨必要盒。
 * 纯字节级断言（不依赖浏览器），确保导出的 mp4 能被播放器解析。
 */
import { describe, expect, it } from "vitest";
import { Mp4Muxer } from "@lingfan-video/infra";
import { makeAacConfig } from "../packages/infra/src/export/mp4/aac";
import {
  extractParameterSets,
  makeAvcC,
} from "../packages/infra/src/export/mp4/avc";

const ASC_48K_STEREO = [0x11, 0x90];

function bytesOf(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((b) => new Uint8Array(b));
}

function u32At(b: Uint8Array, at: number): number {
  return (
    ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!
  );
}

/** 顶层盒：[类型 4 字节, 大小]（size=0 表示到文件尾） */
function topBoxes(
  b: Uint8Array,
): { type: string; start: number; size: number }[] {
  const out: { type: string; start: number; size: number }[] = [];
  let at = 0;
  while (at + 8 <= b.length) {
    const size = u32At(b, at);
    const type = String.fromCharCode(
      b[at + 4]!,
      b[at + 5]!,
      b[at + 6]!,
      b[at + 7]!,
    );
    if (size < 8 || at + size > b.length) break;
    out.push({ type, start: at, size });
    at += size;
  }
  return out;
}

function hasFourcc(b: Uint8Array, name: string): boolean {
  const pat = [...name].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + 4 <= b.length; i += 1) {
    for (let j = 0; j < 4; j += 1) if (b[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

/** 所有 stco（每轨一个）的偏移表，按出现顺序拼接 */
function stcoEntries(b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= b.length; i += 1) {
    if (
      b[i] === 0x73 &&
      b[i + 1] === 0x74 &&
      b[i + 2] === 0x63 &&
      b[i + 3] === 0x6f
    ) {
      // type 之后：version+flags(4) entryCount(4) entries(4 each)
      const count = u32At(b, i + 8);
      for (let k = 0; k < count; k += 1) out.push(u32At(b, i + 12 + k * 4));
    }
  }
  return out;
}

/** 指定盒类型在字节流中的时间刻度（读紧随其后的 version/flags 后的 u32） */
function timescaleOf(b: Uint8Array, fourcc: string): number | null {
  for (let i = 0; i + 4 <= b.length; i += 1) {
    if (
      b[i] === fourcc.charCodeAt(0) &&
      b[i + 1] === fourcc.charCodeAt(1) &&
      b[i + 2] === fourcc.charCodeAt(2) &&
      b[i + 3] === fourcc.charCodeAt(3)
    ) {
      const version = b[i + 4]!;
      if (version !== 0) return null;
      // 版本 0：version+flags(4) → creation(4) → modification(4) → timescale
      return u32At(b, i + 16);
    }
  }
  return null;
}

const videoChunks = [
  {
    data: new Uint8Array([1, 2, 3]),
    timestampUs: 0,
    durationUs: 33_333,
    keyFrame: true,
  },
  {
    data: new Uint8Array([4, 5]),
    timestampUs: 33_333,
    durationUs: 33_333,
    keyFrame: false,
  },
  {
    data: new Uint8Array([6]),
    timestampUs: 66_666,
    durationUs: 33_333,
    keyFrame: false,
  },
];

const videoSpec = {
  width: 4,
  height: 4,
  avcC: new Uint8Array([
    1, 0x64, 0, 0x0a, 0xff, 0xe1, 0, 3, 1, 2, 3, 1, 0, 1, 4, 5,
  ]),
};

const audioSpec = {
  sampleRate: 48_000,
  channels: 2,
  asc: new Uint8Array(ASC_48K_STEREO),
  bitrate: 128_000,
};

const audioChunks = [
  { data: new Uint8Array([0xa1, 0xa2]), durationUs: 21_333 },
  { data: new Uint8Array([0xa3]), durationUs: 21_333 },
];

describe("AAC 声明", () => {
  it("按采样率/声道合成 AudioSpecificConfig", () => {
    expect([...makeAacConfig(48_000, 2)!]).toEqual(ASC_48K_STEREO);
    // 44.1kHz 立体声：rateIndex=4 → 0x12 0x10
    expect([...makeAacConfig(44_100, 2)!]).toEqual([0x12, 0x10]);
  });

  it("采样率不在表内返回 null（由调用方 fail-fast）", () => {
    expect(makeAacConfig(12_345, 2)).toBeNull();
  });
});

describe("AVC 参数集提取", () => {
  // Chrome 的 VideoEncoder 给出的就是 avcC 形态的 decoderConfig.description，
  // 解析必须按 AVCDecoderConfigurationRecord 的头（version=1 / SPS 段 / PPS 段）走。
  const sps = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0xaa, 0xbb]);
  const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);

  it("avcC 形态：从 AVCDecoderConfigurationRecord 取回 SPS/PPS", () => {
    const record = makeAvcC(sps, pps);
    const parsed = extractParameterSets(record.buffer as ArrayBuffer);
    expect([...parsed.sps]).toEqual([...sps]);
    expect([...parsed.pps]).toEqual([...pps]);
  });

  it("Annex B 形态：按起始码切 NAL 并取 type 7/8", () => {
    const annexB = new Uint8Array([0, 0, 1, ...sps, 0, 0, 1, ...pps]);
    const parsed = extractParameterSets(annexB.buffer as ArrayBuffer);
    expect([...parsed.sps]).toEqual([...sps]);
    expect([...parsed.pps]).toEqual([...pps]);
  });

  it("缺 PPS 时抛出（不产出无法解码的文件）", () => {
    const noPps = makeAvcC(sps, pps).slice(0, 6 + 2 + sps.length);
    expect(() => extractParameterSets(noPps.buffer as ArrayBuffer)).toThrow(
      /avcC：/,
    );
  });
});

describe("MP4 封装", () => {
  it("纯视频：ftyp → moov → mdat，mdat 负载即各帧数据首尾相接", async () => {
    const m = new Mp4Muxer();
    for (const c of videoChunks) m.addVideo(c);
    const bytes = await bytesOf(m.finalize(videoSpec));

    const tops = topBoxes(bytes);
    expect(tops.map((t) => t.type)).toEqual(["ftyp", "moov", "mdat"]);
    const mdat = tops[2]!;
    expect(bytes.length).toBe(mdat.start + mdat.size);
    // mdat 负载 = 8 字节头之后的原始数据
    const payload = bytes.subarray(mdat.start + 8);
    expect([...payload]).toEqual([1, 2, 3, 4, 5, 6]);
    // 无音轨
    expect(hasFourcc(bytes, "mp4a")).toBe(false);
    expect(hasFourcc(bytes, "esds")).toBe(false);
  });

  it("带音轨：两个 trak、stco 偏移指向各自数据、音频盒齐备", async () => {
    const video = new Mp4Muxer();
    for (const c of videoChunks) video.addVideo(c);
    const videoOnly = await bytesOf(video.finalize(videoSpec));

    const m = new Mp4Muxer();
    for (const c of videoChunks) m.addVideo(c);
    for (const c of audioChunks) m.addAudio(c);
    const bytes = await bytesOf(m.finalize(videoSpec, audioSpec));

    expect(hasFourcc(bytes, "mp4a")).toBe(true);
    expect(hasFourcc(bytes, "esds")).toBe(true);
    expect([...bytesOfAsc(bytes)]).toEqual(ASC_48K_STEREO);

    // stco：视频块偏移 = 文件头长度；音频块紧随视频负载
    const offsets = stcoEntries(bytes);
    expect(offsets.length).toBe(2);
    const tops = topBoxes(bytes);
    const ftyp = tops[0]!;
    const moov = tops[1]!;
    const videoBytes = videoChunks.reduce((s, c) => s + c.data.length, 0);
    expect(offsets[0]).toBe(ftyp.size + moov.size + 8);
    expect(offsets[1]).toBe(offsets[0]! + videoBytes);

    // 音频写入不应改变视频部分的字节布局（同一 moov 尺寸量法）
    expect(videoOnly.length).toBeLessThan(bytes.length);
    expect(hasFourcc(videoOnly, "mp4a")).toBe(false);

    // mdat 负载 = 视频块 + 音频块
    const mdat = tops[2]!;
    expect([...bytes.subarray(mdat.start + 8)]).toEqual([
      1, 2, 3, 4, 5, 6, 0xa1, 0xa2, 0xa3,
    ]);
  });

  it("电影刻度为毫秒、音频轨刻度为采样率", async () => {
    const m = new Mp4Muxer();
    for (const c of videoChunks) m.addVideo(c);
    for (const c of audioChunks) m.addAudio(c);
    const bytes = await bytesOf(m.finalize(videoSpec, audioSpec));

    expect(timescaleOf(bytes, "mvhd")).toBe(1000);
    // 头两个 mdhd：视频轨用毫秒刻度，音频轨用采样率刻度
    const scales: number[] = [];
    for (let i = 0; i + 4 <= bytes.length; i += 1) {
      if (
        bytes[i] === 0x6d &&
        bytes[i + 1] === 0x64 &&
        bytes[i + 2] === 0x68 &&
        bytes[i + 3] === 0x64
      ) {
        scales.push(u32At(bytes, i + 16));
      }
    }
    expect(scales).toEqual([1000, 48_000]);
  });

  it("未编码帧时 finalize 仍产出可解析文件（空 mdat）", async () => {
    const m = new Mp4Muxer();
    const bytes = await bytesOf(m.finalize(videoSpec));
    expect(topBoxes(bytes).map((t) => t.type)).toEqual([
      "ftyp",
      "moov",
      "mdat",
    ]);
    expect(m.videoCount).toBe(0);
    expect(m.audioCount).toBe(0);
  });
});

/** esds 内嵌的 DecoderSpecificInfo 负载即 ASC（紧随 0x05 + 长度） */
function bytesOfAsc(mp4: Uint8Array): Uint8Array {
  for (let i = 0; i + 2 <= mp4.length; i += 1) {
    if (mp4[i] === 0x05) {
      const len = mp4[i + 1]!;
      if (
        len === 2 &&
        mp4[i + 2] === ASC_48K_STEREO[0] &&
        mp4[i + 3] === ASC_48K_STEREO[1]
      )
        return mp4.subarray(i + 2, i + 4);
    }
  }
  return new Uint8Array();
}
