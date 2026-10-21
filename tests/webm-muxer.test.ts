/**
 * WebM 封装：EBML 骨架、轨道表、块形态、簇切分与索引表。
 *
 * 纯字节级断言（不依赖浏览器）：这里不解码视频，只确认容器结构与规范一致——
 * 不透明块走 `SimpleBlock`，带 alpha 的块走 `BlockGroup` + `BlockAdditions`，
 * 索引点落在关键帧簇上并指得准。
 */
import { describe, expect, it } from "vitest";
import { WebmMuxer } from "@lingfan-video/infra";

/** 元素 ID 常量：与实现分开写，避免「拿实现自己的常量验证实现」 */
const ID = {
  EBML: 0x1a45dfa3,
  DOC_TYPE: 0x4282,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  DEFAULT_DURATION: 0x23e383,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  ALPHA_MODE: 0x53c0,
  AUDIO: 0xe1,
  SAMPLING_FREQUENCY: 0xb5,
  CHANNELS: 0x9f,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_ADDITIONS: 0x75a1,
  BLOCK_MORE: 0xa6,
  BLOCK_ADD_ID: 0xee,
  BLOCK_ADDITIONAL: 0xa5,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_CLUSTER_POSITION: 0xf1,
} as const;

/** 解析出来的元素：ID、负载区间与在父级里的起止偏移 */
interface Node {
  readonly id: number;
  readonly start: number;
  readonly payloadStart: number;
  readonly payloadEnd: number;
}

/**
 * 由首字节算出这个变长字段占几个字节。
 *
 * 规范用「首个置位比特的位置」表达长度：`1xxxxxxx` 是 1 字节，`01xxxxxx` 是 2 字节，
 * 依此类推。首字节为 0 时长度字段非法，这里直接抛错而不是猜。
 *
 * @param first 首字节
 * @returns 占用的字节数（1..8）
 */
function vintLength(first: number): number {
  for (let bit = 7; bit >= 0; bit--) if (first & (1 << bit)) return 8 - bit;
  throw new Error(`非法变长首字节：0x${first.toString(16)}`);
}

/**
 * 读 EBML 元素 ID。
 *
 * ID 的长度标记位属于 ID 值的一部分，所以整段字节原样当数值读。
 *
 * @param bytes 源字节
 * @param at 读取位置
 * @returns ID 数值与占用字节数
 */
function readId(bytes: Uint8Array, at: number): { id: number; length: number } {
  /** ID 占用字节数 */
  const length = vintLength(bytes[at]!);
  /** ID 数值：标记位保留在值里 */
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i]!;
  return { id, length };
}

/**
 * 读 EBML 长度字段（VINT，标记位不属于数值）。
 *
 * @param bytes 源字节
 * @param at 读取位置
 * @returns 长度值与占用字节数；`unknown` 表示全 1（长度未知）
 */
function readSize(
  bytes: Uint8Array,
  at: number,
): { value: number; length: number; unknown: boolean } {
  /** 长度字段占用字节数 */
  const length = vintLength(bytes[at]!);
  /** 标记位掩码：首字节里属于数值的部分 */
  const mask = 0xff >> length;
  /** 去掉标记位后的首段数值 */
  let value = bytes[at]! & mask;
  /** 是否全 1（长度未知） */
  let unknown = value === mask;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

/**
 * 把一段字节按元素切开（只切一层，不递归）。
 *
 * @param bytes 源字节
 * @param from 起（含）
 * @param to 止（不含）
 * @returns 平级元素列表
 */
function children(bytes: Uint8Array, from: number, to: number): Node[] {
  /** 结果 */
  const out: Node[] = [];
  let at = from;
  while (at < to) {
    const { id, length: idLength } = readId(bytes, at);
    const size = readSize(bytes, at + idLength);
    const payloadStart = at + idLength + size.length;
    const payloadEnd = payloadStart + size.value;
    out.push({ id, start: at, payloadStart, payloadEnd });
    at = payloadEnd;
  }
  return out;
}

/**
 * 把某个偏移上的元素读成一个节点（头部 + 负载区间）。
 *
 * @param bytes 源字节
 * @param at 元素起点
 * @returns 节点
 */
function nodeAt(bytes: Uint8Array, at: number): Node {
  /** 元素 ID 及其占用字节数 */
  const { id, length: idLength } = readId(bytes, at);
  /** 长度字段 */
  const size = readSize(bytes, at + idLength);
  /** 负载起点 */
  const payloadStart = at + idLength + size.length;
  return { id, start: at, payloadStart, payloadEnd: payloadStart + size.value };
}

/**
 * 取某元素的直接子元素。
 *
 * @param bytes 源字节
 * @param node 父元素
 * @returns 子元素列表
 */
function sub(bytes: Uint8Array, node: Node): Node[] {
  return children(bytes, node.payloadStart, node.payloadEnd);
}

/**
 * 按 ID 找第一个子元素。
 *
 * @param bytes 源字节
 * @param node 父元素
 * @param id 目标 ID
 * @returns 命中的子元素；没有则 `undefined`
 */
function find(bytes: Uint8Array, node: Node, id: number): Node | undefined {
  return sub(bytes, node).find((item) => item.id === id);
}

/**
 * 取元素负载区间。
 *
 * @param bytes 源字节
 * @param node 元素
 * @returns 负载字节（视图，不复制）
 */
function payload(bytes: Uint8Array, node: Node): Uint8Array {
  return bytes.subarray(node.payloadStart, node.payloadEnd);
}

/**
 * 把无符号整数负载读成数（大端）。
 *
 * @param bytes 负载字节
 * @returns 数值
 */
function readUint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/**
 * 把浮点负载读成数（8 字节双精度大端）。
 *
 * @param bytes 负载字节
 * @returns 数值
 */
function readFloat(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getFloat64(0, false);
}

/**
 * 把文本负载读成字符串。
 *
 * @param bytes 负载字节
 * @returns 文本
 */
function readText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 段内某个绝对偏移（相对段负载起点）对应的元素起点 */
function topLevel(bytes: Uint8Array): { header: Node; segment: Node } {
  const roots = children(bytes, 0, bytes.length);
  const header = roots.find((item) => item.id === ID.EBML)!;
  const segment = roots.find((item) => item.id === ID.SEGMENT)!;
  return { header, segment };
}

/**
 * 造一个视频块。
 *
 * @param timestampUs 时间戳（微秒）
 * @param keyFrame 是否关键帧
 * @param alpha 可选的 alpha 平面字节
 * @returns 待追加的块
 */
function video(
  timestampUs: number,
  keyFrame: boolean,
  alpha?: Uint8Array,
): {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
  keyFrame: boolean;
  alpha?: Uint8Array;
} {
  return {
    data: new Uint8Array([0xaa, 0xbb]),
    timestampUs,
    durationUs: 40_000,
    keyFrame,
    ...(alpha ? { alpha } : {}),
  };
}

/** 一份标准的视频轨声明 */
const VIDEO_SPEC = {
  width: 4,
  height: 2,
  codec: "V_VP9" as const,
  defaultDurationNs: 33_333_333,
  alpha: false,
};

describe("WebM 封装：容器骨架", () => {
  it("顶层是 EBML 头 + 段，DocType 声明 webm", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true));
    const bytes = muxer.finalize(VIDEO_SPEC);

    const { header, segment } = topLevel(bytes);
    expect(readText(payload(bytes, find(bytes, header, ID.DOC_TYPE)!))).toBe(
      "webm",
    );
    expect(segment.id).toBe(ID.SEGMENT);
    // 段是文件里最后一个元素，长度写实际字节数（不是「未知长度」）
    const size = readSize(bytes, segment.start + 4);
    expect(size.unknown).toBe(false);
    expect(segment.payloadEnd).toBe(bytes.length);
  });

  it("轨道表写着编解码器、像素尺寸与默认帧时长", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true));
    const bytes = muxer.finalize(VIDEO_SPEC);

    const { segment } = topLevel(bytes);
    const tracks = find(bytes, segment, ID.TRACKS)!;
    const entry = find(bytes, tracks, ID.TRACK_ENTRY)!;
    expect(readText(payload(bytes, find(bytes, entry, ID.CODEC_ID)!))).toBe(
      "V_VP9",
    );
    expect(readUint(payload(bytes, find(bytes, entry, ID.TRACK_NUMBER)!))).toBe(
      1,
    );
    expect(
      readUint(payload(bytes, find(bytes, entry, ID.DEFAULT_DURATION)!)),
    ).toBe(33_333_333);
    const videoNode = find(bytes, entry, ID.VIDEO)!;
    expect(
      readUint(payload(bytes, find(bytes, videoNode, ID.PIXEL_WIDTH)!)),
    ).toBe(4);
    expect(
      readUint(payload(bytes, find(bytes, videoNode, ID.PIXEL_HEIGHT)!)),
    ).toBe(2);
    // 不透明档不声明 AlphaMode：多写它会让播放器去找不存在的附加块
    expect(find(bytes, videoNode, ID.ALPHA_MODE)).toBeUndefined();
  });

  it("透明档在轨道上声明 AlphaMode", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true, new Uint8Array([0x11])));
    const bytes = muxer.finalize({ ...VIDEO_SPEC, alpha: true });

    const { segment } = topLevel(bytes);
    const entry = find(
      bytes,
      find(bytes, segment, ID.TRACKS)!,
      ID.TRACK_ENTRY,
    )!;
    const videoNode = find(bytes, entry, ID.VIDEO)!;
    expect(
      readUint(payload(bytes, find(bytes, videoNode, ID.ALPHA_MODE)!)),
    ).toBe(1);
  });

  it("时长取所有块的最晚结束时刻", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true));
    muxer.addVideo(video(40_000, false));
    const bytes = muxer.finalize(VIDEO_SPEC);

    const { segment } = topLevel(bytes);
    const info = find(bytes, segment, ID.INFO)!;
    expect(readFloat(payload(bytes, find(bytes, info, ID.DURATION)!))).toBe(80);
    expect(
      readUint(payload(bytes, find(bytes, info, ID.TIMECODE_SCALE)!)),
    ).toBe(1_000_000);
  });
});

describe("WebM 封装：块的两种形态", () => {
  it("不透明块走 SimpleBlock，关键帧标志位写在块头", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true));
    muxer.addVideo(video(40_000, false));
    const bytes = muxer.finalize(VIDEO_SPEC);

    const { segment } = topLevel(bytes);
    const blocks = sub(bytes, segment).filter((item) => item.id === ID.CLUSTER);
    const simples = blocks.flatMap((node) =>
      sub(bytes, node).filter((item) => item.id === ID.SIMPLE_BLOCK),
    );
    expect(simples).toHaveLength(2);
    // 块头：轨道号（VINT 0x81）+ 相对时间码（int16）+ 标志位
    expect(Array.from(payload(bytes, simples[0]!)).slice(0, 3)).toEqual([
      0x81, 0x00, 0x00,
    ]);
    expect(payload(bytes, simples[0]!)[3]).toBe(0x80);
    expect(payload(bytes, simples[1]!)[3]).toBe(0x00);
    // 第二块相对簇时间码偏移 40ms：块头里是 16 位有符号大端
    const relative =
      (payload(bytes, simples[1]!)[1]! << 8) | payload(bytes, simples[1]!)[2]!;
    expect(relative).toBe(40);
  });

  it("透明块走 BlockGroup：块本体 + BlockAdditions 里的 alpha 平面", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true, new Uint8Array([0x11, 0x22])));
    const bytes = muxer.finalize({ ...VIDEO_SPEC, alpha: true });

    const { segment } = topLevel(bytes);
    const clusterNode = sub(bytes, segment).find(
      (item) => item.id === ID.CLUSTER,
    )!;
    const group = find(bytes, clusterNode, ID.BLOCK_GROUP)!;
    // 走块组时不写 SimpleBlock：两者互斥，一条轨道同一帧只能有一种块
    expect(find(bytes, clusterNode, ID.SIMPLE_BLOCK)).toBeUndefined();
    expect(find(bytes, group, ID.BLOCK)).toBeDefined();
    const additions = find(bytes, group, ID.BLOCK_ADDITIONS)!;
    const more = find(bytes, additions, ID.BLOCK_MORE)!;
    // 附加编号 1 = alpha 平面（VINT 编码为 0x81）
    expect(
      Array.from(payload(bytes, find(bytes, more, ID.BLOCK_ADD_ID)!)),
    ).toEqual([0x81]);
    expect(
      Array.from(payload(bytes, find(bytes, more, ID.BLOCK_ADDITIONAL)!)),
    ).toEqual([0x11, 0x22]);
  });
});

describe("WebM 封装：簇与索引", () => {
  it("关键帧开新簇，索引点指回的簇时间码就是它", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true));
    muxer.addVideo(video(40_000, false));
    muxer.addVideo(video(80_000, true));
    const bytes = muxer.finalize(VIDEO_SPEC);

    const { segment } = topLevel(bytes);
    const clusters = sub(bytes, segment).filter(
      (item) => item.id === ID.CLUSTER,
    );
    expect(clusters).toHaveLength(2);

    const cues = find(bytes, segment, ID.CUES)!;
    const points = sub(bytes, cues).filter((item) => item.id === ID.CUE_POINT);
    expect(points).toHaveLength(2);
    for (const point of points) {
      const time = readUint(payload(bytes, find(bytes, point, ID.CUE_TIME)!));
      const positions = find(bytes, point, ID.CUE_TRACK_POSITIONS)!;
      const offset = readUint(
        payload(bytes, find(bytes, positions, ID.CUE_CLUSTER_POSITION)!),
      );
      // 索引偏移是相对段负载的：落点必须正好是一个簇的起点
      const landing = nodeAt(bytes, segment.payloadStart + offset);
      expect(landing.id).toBe(ID.CLUSTER);
      expect(readUint(payload(bytes, find(bytes, landing, ID.TIMECODE)!))).toBe(
        time,
      );
    }
  });

  it("音频块与视频块按时间合并进同一簇", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true));
    muxer.addAudio({
      data: new Uint8Array([0x33]),
      timestampUs: 20_000,
      durationUs: 20_000,
    });
    const bytes = muxer.finalize(VIDEO_SPEC, {
      sampleRate: 48_000,
      channels: 2,
      codecPrivate: new Uint8Array([1, 2, 3]),
    });

    const { segment } = topLevel(bytes);
    const clusterNode = sub(bytes, segment).find(
      (item) => item.id === ID.CLUSTER,
    )!;
    const blocks = sub(bytes, clusterNode).filter(
      (item) => item.id === ID.SIMPLE_BLOCK,
    );
    expect(blocks).toHaveLength(2);
    // 第二块是音频：轨道号 2（VINT 0x82），相对时间码 20ms
    expect(payload(bytes, blocks[1]!)[0]).toBe(0x82);
    expect(payload(bytes, blocks[1]!)[2]).toBe(20);
  });
});

describe("WebM 封装：音频轨与收尾", () => {
  it("音频轨写 A_OPUS 与 19 字节 OpusHead", () => {
    const muxer = new WebmMuxer();
    muxer.addVideo(video(0, true));
    muxer.addAudio({
      data: new Uint8Array([0x33]),
      timestampUs: 0,
      durationUs: 20_000,
    });
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode("OpusHead"), 0);
    const bytes = muxer.finalize(VIDEO_SPEC, {
      sampleRate: 48_000,
      channels: 2,
      codecPrivate: head,
    });

    const { segment } = topLevel(bytes);
    const entries = sub(bytes, find(bytes, segment, ID.TRACKS)!).filter(
      (item) => item.id === ID.TRACK_ENTRY,
    );
    expect(entries).toHaveLength(2);
    const audioEntry = entries[1]!;
    expect(
      readText(payload(bytes, find(bytes, audioEntry, ID.CODEC_ID)!)),
    ).toBe("A_OPUS");
    expect(
      payload(bytes, find(bytes, audioEntry, ID.CODEC_PRIVATE)!),
    ).toHaveLength(19);
    const audioNode = find(bytes, audioEntry, ID.AUDIO)!;
    expect(
      readFloat(payload(bytes, find(bytes, audioNode, ID.SAMPLING_FREQUENCY)!)),
    ).toBe(48_000);
    expect(readUint(payload(bytes, find(bytes, audioNode, ID.CHANNELS)!))).toBe(
      2,
    );
  });

  it("没有视频块时收尾明确报错，而不是出一个空文件", () => {
    const muxer = new WebmMuxer();
    expect(() => muxer.finalize(VIDEO_SPEC)).toThrow(/没有视频块/);
  });
});
