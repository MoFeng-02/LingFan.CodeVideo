/**
 * WebCodecs 导出适配器（Exporter 的 'webcodecs' 实现）：
 * VideoFrame 编码 + mp4 封装（简单 MP4 muxer：avc1 裸流 → 可播放文件）。
 * 仅浏览器环境可用（VideoFrame/AudioEncoder 为平台 API）；Node 下组合根应选 frames。
 */
import type {
  ExportResult,
  Exporter,
  FrameBitmap,
  Ms,
} from "@lingfan-video/contracts";

interface EncodedChunk {
  data: Uint8Array;
  /** 微秒（VideoEncoder 输出标准单位） */
  timestampUs: number;
  durationUs: number;
  keyFrame: boolean;
}

export interface WebCodecsExporterOptions {
  width: number;
  height: number;
  fps: number;
  /** 码率（bps），缺省 8Mbps */
  bitrate?: number;
}

/**
 * 最小 mp4 封装：avcC + 单 mdat，fMP4 无需——浏览器 <video> 可播基本流即可。
 * 生成 ftyp + moov（trak/stsd(avc1/avcC)/stts/stsc/stsz/stco）+ mdat。
 */
class MinimalMp4Muxer {
  private readonly chunks: EncodedChunk[] = [];

  add(chunk: EncodedChunk): void {
    this.chunks.push(chunk);
  }

  finalize(
    width: number,
    height: number,
    sps: Uint8Array,
    pps: Uint8Array,
  ): Blob {
    const mdatPayloadSize = this.chunks.reduce((s, c) => s + c.data.length, 0);
    const avcC = makeAvcC(sps, pps);
    const moov = makeMoov(width, height, this.chunks, avcC);
    const ftyp = makeFtyp();
    const mdatHeader = boxHeader("mdat", 8 + mdatPayloadSize);
    return new Blob(
      [
        ab(ftyp),
        ab(moov),
        ab(mdatHeader),
        ...this.chunks.map((c) => ab(c.data)),
      ],
      { type: "video/mp4" },
    );
  }
}

function boxHeader(type: string, size: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((s, p) => s + p.length, 0);
  return concat([boxHeader(type, size), ...payload]);
}

/** Uint8Array → 纯 ArrayBuffer 视图（Blob/BrowserBuffer 需要 ArrayBuffer 而非 SharedArrayBuffer） */
function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(
    u.byteOffset,
    u.byteOffset + u.byteLength,
  ) as ArrayBuffer;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32 = (v: number) => new Uint8Array(new Uint32Array([v]).buffer);
const u16 = (v: number) => new Uint8Array(new Uint16Array([v]).buffer);
const timescale = 1000; // ms 计（与时间线同刻度）

function makeFtyp(): Uint8Array {
  return box(
    "ftyp",
    concat([new TextEncoder().encode("isom")]),
    u32(512),
    concat([new TextEncoder().encode("isomiso2avc1mp41")]),
  );
}

function makeAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return concat([
    new Uint8Array([0x01, sps[1]!, sps[2]!, sps[3]!, 0xfc, 0xe0 | 1]),
    u16(sps.length),
    sps,
    new Uint8Array([1]),
    u16(pps.length),
    pps,
  ]);
}

/** 合并 SPS/PPS 为单个（v0.1 只支持单 SPS/PPS） */
export function extractParameterSets(desc: ArrayBuffer): {
  sps: Uint8Array;
  pps: Uint8Array;
} {
  const raw = new Uint8Array(desc);
  const nalu: Uint8Array[] = [];
  let i = 0;
  while (i < raw.length) {
    const len = new DataView(raw.buffer, raw.byteOffset + i).getUint16(0);
    nalu.push(raw.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  const byType = (t: number) => nalu.find((n) => (n[0]! & 0x1f) === t)!;
  return { sps: byType(7), pps: byType(8) };
}

function makeMoov(
  width: number,
  height: number,
  chunks: EncodedChunk[],
  avcC: Uint8Array,
): Uint8Array {
  const durationMs = chunks.length
    ? chunks[chunks.length - 1]!.timestampUs / 1000 +
      chunks[chunks.length - 1]!.durationUs / 1000
    : 0;

  // stts：按连续相同 duration 分段（固定 fps 下通常一段）
  const sttsEntries: Array<[number, number]> = [];
  for (const c of chunks) {
    const d = Math.round(c.durationUs / 1000);
    const last = sttsEntries[sttsEntries.length - 1];
    if (last && last[1] === d) last[0]++;
    else sttsEntries.push([1, d]);
  }

  const stsz = box(
    "stsz",
    u32(0),
    u32(chunks.length),
    ...chunks.map((c) => u32(c.data.length)),
  );
  const stco = box("stco", u32(1), u32(0)); // mdat 偏移回填
  const stts = box(
    "stts",
    u32(sttsEntries.length),
    ...sttsEntries.flatMap(([n, d]) => [u32(n), u32(d)]),
  );

  const avc1 = box(
    "avc1",
    new Uint8Array(6),
    u16(1),
    u16(0),
    u16(0),
    new Uint8Array(12),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    new Uint8Array(32),
    u16(24),
    u16(0xffff),
    box("avcC", avcC),
  );
  const stsd = box("stsd", u32(1), avc1);
  const stbl = box("stbl", stsd, stts, stsz, stco);
  const stss = box(
    "stss",
    u32(chunks.filter((c) => c.keyFrame).length),
    ...chunks
      .map((c, i) => (c.keyFrame ? i + 1 : 0))
      .filter((v) => v > 0)
      .map(u32),
  );
  const mdia = box(
    "mdia",
    box(
      "mdhd",
      u32(0),
      u32(0),
      u32(timescale),
      u32(durationMs),
      u16(0x55c4),
      u16(0),
    ),
    box(
      "hdlr",
      new Uint8Array(8),
      concat([new TextEncoder().encode("vide")]),
      new Uint8Array(12),
    ),
    box("minf", box("vmhd", new Uint8Array(8), u16(1)), stbl),
  );
  const tkhd = box(
    "tkhd",
    u32(0x00000007),
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(durationMs),
    new Uint8Array(8),
    u16(0),
    u16(0),
    u32(0x10000),
    u16(width),
    u16(height),
    u32(0),
    u32(0),
    u32(0),
  );
  const trak = box("trak", tkhd, mdia);
  const mvhd = box(
    "mvhd",
    u32(0),
    u32(0),
    u32(0),
    u32(timescale),
    u32(durationMs),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(2),
    u32(0x10000),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(2),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  );
  return box("moov", mvhd, trak);
}

export class WebCodecsExporter implements Exporter {
  readonly impl = "webcodecs" as const;
  readonly format = "mp4" as const;
  private readonly muxer = new MinimalMp4Muxer();
  private readonly opts: WebCodecsExporterOptions;
  private encoder: VideoEncoder | null = null;
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private lastTimestampUs: number | null = null;
  private count = 0;
  private durationMs: Ms = 0;

  constructor(opts: WebCodecsExporterOptions) {
    this.opts = opts;
  }

  async writeFrame(frame: FrameBitmap, timestampMs: Ms): Promise<void> {
    if (typeof VideoFrame === "undefined")
      throw new Error(
        "WebCodecsExporter 需要 WebCodecs 环境（浏览器）；Node 请用 FrameSequenceExporter",
      );
    this.ensureEncoder();
    const timestampUs = Math.round(timestampMs * 1000);
    const durationUs =
      this.lastTimestampUs === null
        ? Math.round(1000000 / this.opts.fps)
        : timestampUs - this.lastTimestampUs;
    this.lastTimestampUs = timestampUs;
    this.durationMs = timestampMs;

    const videoFrame = new VideoFrame(frame.data.buffer, {
      format: "RGBA",
      codedWidth: this.opts.width,
      codedHeight: this.opts.height,
      timestamp: timestampUs,
      duration: durationUs,
    });
    await new Promise<void>((resolve) => {
      const enc = this.encoder!;
      enc.ondequeue = () => resolve();
      enc.encode(videoFrame, { keyFrame: this.count % 60 === 0 });
      videoFrame.close();
      this.count++;
      resolve();
    });
  }

  private ensureEncoder(): void {
    if (this.encoder) return;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.sps) {
          const ps = extractParameterSets(desc as ArrayBuffer);
          this.sps = ps.sps;
          this.pps = ps.pps;
        }
        this.muxer.add({
          data: new Uint8Array(chunk.byteLength),
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 0,
          keyFrame: chunk.type === "key",
        });
      },
      error: (e) => {
        throw new Error(`VideoEncoder 错误：${e.message}`);
      },
    });
    encoder.configure({
      codec: "avc1.42001f",
      width: this.opts.width,
      height: this.opts.height,
      bitrate: this.opts.bitrate ?? 8_000_000,
      framerate: this.opts.fps,
      avc: { format: "avc" },
    });
    this.encoder = encoder;
  }

  async finalize(): Promise<ExportResult> {
    if (!this.encoder)
      throw new Error(
        "WebCodecsExporter：无已编码帧（finalize 前需 writeFrame）",
      );
    await this.encoder.flush();
    this.encoder.close();
    const output = this.muxer.finalize(
      this.opts.width,
      this.opts.height,
      this.sps!,
      this.pps!,
    );
    return {
      output,
      frames: this.count,
      durationMs: this.durationMs,
      format: "mp4",
    };
  }
}
