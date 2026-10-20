/**
 * 透明产物：APNG 封装的结构正确性与像素保真。
 * 覆盖：
 * 1. 分块顺序与 CRC 合法（解码器会按 CRC 拒收整份文件）；
 * 2. alpha 通道逐字节落进产物（这是「透明」到底成不成立的唯一判据）；
 * 3. 变帧率的停留时长按相邻时间戳差表达；
 * 4. 只收 CPU 位图：设备句柄与尺寸不符的帧都明确报错；
 * 5. 同一组输入两次封装的字节完全相同（确定性）。
 */
import { describe, expect, it } from "vitest";
import type { FrameBitmap } from "@lingfan-video/contracts";
import { ApngExporter, crc32 } from "@lingfan-video/infra";

const W = 4;
const H = 2;

/** 造一帧：右上角一个半透明红点，其余全透明 */
function frame(alphaAt: (x: number, y: number) => number): FrameBitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = 255;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = alphaAt(x, y);
    }
  }
  return { data, width: W, height: H };
}

/** 逐块读 APNG：返回类型与负载，顺带校验每块 CRC */
function readChunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const expected = view.getUint32(offset + 8 + length);
    // CRC 覆盖「类型 + 负载」，这是 PNG 规范定死的算法
    expect(crc32(bytes.subarray(offset + 4, offset + 8 + length))).toBe(
      expected,
    );
    chunks.push({ type, data: payload });
    offset += 12 + length;
  }
  return chunks;
}

/** 解 IDAT/fdAT 的 zlib 负载，还原扫描线；过滤器固定 None */
async function inflate(payload: Uint8Array): Promise<number[]> {
  const stream = new Blob([payload as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const buffer = await new Response(stream).arrayBuffer();
  return Array.from(new Uint8Array(buffer));
}

describe("透明产物：APNG 封装", () => {
  it("分块顺序是 签名/IHDR/acTL/fcTL+IDAT/…/IEND，每块 CRC 合法", async () => {
    const exporter = new ApngExporter({ width: W, height: H });
    await exporter.writeFrame(
      frame(() => 0),
      0,
    );
    await exporter.writeFrame(
      frame(() => 128),
      100,
    );
    const result = await exporter.finalize();
    expect(result.format).toBe("apng");
    expect(result.frames).toBe(2);

    const chunks = readChunks(exporter.fileBytes!);
    expect(chunks.map((c) => c.type)).toEqual([
      "IHDR",
      "acTL",
      "fcTL",
      "IDAT",
      "fcTL",
      "fdAT",
      "IEND",
    ]);
    // IHDR：位深 8、颜色类型 6（RGBA，带 alpha）、不隔行
    expect(Array.from(chunks[0]!.data.subarray(8, 13))).toEqual([
      8, 6, 0, 0, 0,
    ]);
    // acTL：总帧数与循环次数
    const actl = new DataView(
      chunks[1]!.data.buffer,
      chunks[1]!.data.byteOffset,
      chunks[1]!.data.byteLength,
    );
    expect(actl.getUint32(0)).toBe(2);
  });

  it("alpha 通道逐字节落进产物（透明才是这条路的全部意义）", async () => {
    const exporter = new ApngExporter({ width: W, height: H });
    // 每列 alpha 递增，解压后按扫描线核对
    await exporter.writeFrame(
      frame((x) => x * 60),
      0,
    );
    await exporter.finalize();

    const chunks = readChunks(exporter.fileBytes!);
    const idat = chunks.find((c) => c.type === "IDAT")!;
    const raw = await inflate(idat.data);
    // 每行 1 字节过滤标记 + W×4 字节像素
    expect(raw).toHaveLength((W * 4 + 1) * H);
    expect(raw[0]).toBe(0); // 过滤类型 None
    for (let y = 0; y < H; y++) {
      const rowStart = y * (W * 4 + 1) + 1;
      for (let x = 0; x < W; x++) {
        expect(raw[rowStart + x * 4 + 3]).toBe(x * 60);
      }
    }
  });

  it("停留时长按相邻时间戳差表达，末帧沿用前一间隔", async () => {
    const exporter = new ApngExporter({ width: W, height: H });
    await exporter.writeFrame(
      frame(() => 0),
      0,
    );
    await exporter.writeFrame(
      frame(() => 0),
      40,
    );
    await exporter.writeFrame(
      frame(() => 0),
      120,
    );
    await exporter.finalize();

    const chunks = readChunks(exporter.fileBytes!);
    const delays = chunks
      .filter((c) => c.type === "fcTL")
      .map((c) => {
        const view = new DataView(
          c.data.buffer,
          c.data.byteOffset,
          c.data.byteLength,
        );
        return [view.getUint16(20, true), view.getUint16(22, true)];
      });
    // 分母 1000 → 分子即毫秒；变帧率的间隔原样表达
    expect(delays).toEqual([
      [40, 1000],
      [80, 1000],
      [80, 1000],
    ]);
  });

  it("只收 CPU 位图：句柄与尺寸不符的帧都明确报错", async () => {
    const exporter = new ApngExporter({ width: W, height: H });
    await expect(
      exporter.writeFrame(
        {
          kind: "handle",
          native: {},
          width: W,
          height: H,
          close() {},
        },
        0,
      ),
    ).rejects.toThrow(/需要 CPU 像素/);

    const wrong = {
      data: new Uint8ClampedArray(2 * 2 * 4),
      width: 2,
      height: 2,
    };
    await expect(exporter.writeFrame(wrong, 0)).rejects.toThrow(/帧尺寸不一致/);
  });

  it("同一组输入两次封装得到完全相同的字节", async () => {
    const build = async (): Promise<Uint8Array> => {
      const exporter = new ApngExporter({ width: W, height: H });
      await exporter.writeFrame(
        frame((x) => x * 60),
        0,
      );
      await exporter.writeFrame(
        frame((x) => 255 - x * 60),
        100,
      );
      await exporter.finalize();
      return exporter.fileBytes!;
    };
    expect(Array.from(await build())).toEqual(Array.from(await build()));
  });
});
