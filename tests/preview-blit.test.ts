/**
 * 预览贴帧：合成出来的设备侧帧必须贴回舞台，否则预览只看得到底图。
 * 这里用记录型画布验证「贴了」以及「内核抛停时也先贴」，
 * 并确认位图载体走的是一次性的 putImageData。
 */
import { describe, expect, it } from "vitest";

import type { ExportResult, Exporter } from "@lingfan-video/contracts";
import { CanvasBlitExporter } from "@lingfan-video/infra";

import { makeRecordingCanvas } from "./support/recording-canvas";

function stubExporter(failAtFrame = -1): Exporter {
  let count = 0;
  return {
    impl: "frames",
    format: "frames",
    async writeFrame() {
      const at = count++;
      if (at === failAtFrame) throw new Error("停在这里");
    },
    async finalize(): Promise<ExportResult> {
      return {
        output: "(stub)",
        frames: count,
        durationMs: 0,
        format: "frames",
      };
    },
  };
}

/** 设备侧载体：`native` 只要能交给 drawImage 就行 */
const handle = (native: unknown) => ({
  kind: "handle" as const,
  native,
  width: 8,
  height: 8,
  close: () => {},
});

describe("CanvasBlitExporter", () => {
  it("把句柄贴到目标画布，并且先让内核处理", async () => {
    const target = makeRecordingCanvas(8, 8);
    const blit = new CanvasBlitExporter(stubExporter(), target.canvas);
    await blit.writeFrame(handle({ tag: "surface" }), 0);
    expect(target.calls()).toBeGreaterThan(0);
  });

  it("内核抛错时也要贴这一帧（定格停住的必须是目标帧）", async () => {
    const target = makeRecordingCanvas(8, 8);
    const blit = new CanvasBlitExporter(stubExporter(1), target.canvas);
    await blit.writeFrame(handle({ tag: "surface" }), 0);
    expect(target.calls()).toBeGreaterThan(0);
    await expect(
      blit.writeFrame(handle({ tag: "surface" }), 33),
    ).rejects.toThrow("停在这里");
    // 第二帧虽然抛了，但已经贴上去：舞台停的就是这一帧
    expect(target.calls()).toBeGreaterThan(1);
  });

  it("位图载体走 putImageData（预览里只有占位位图，不做重活）", async () => {
    const target = makeRecordingCanvas(8, 8);
    const blit = new CanvasBlitExporter(stubExporter(), target.canvas);
    const before = target.calls();
    await blit.writeFrame(
      { data: new Uint8ClampedArray(4), width: 1, height: 1 },
      0,
    );
    expect(target.calls()).toBeGreaterThan(before);
  });

  it("内层没有音轨通道时，装饰器也不声称自己收音频", async () => {
    const target = makeRecordingCanvas(8, 8);
    const blit = new CanvasBlitExporter(stubExporter(), target.canvas);
    // 预览节拍导出器就没有 writeAudio：装饰器照抄能力面，否则组合根误判成
    // 「有音轨出口但没给时钟」而拒绝推演
    expect(blit.writeAudio).toBeUndefined();
  });

  it("内层收音频时，装饰器把音频原样转发", async () => {
    const target = makeRecordingCanvas(8, 8);
    const chunks: number[] = [];
    const inner: Exporter = {
      ...stubExporter(),
      async writeAudio(samples: Float32Array) {
        chunks.push(samples.length);
      },
    };
    const blit = new CanvasBlitExporter(inner, target.canvas);
    await blit.writeAudio!(new Float32Array(6), 48_000, 2);
    expect(chunks).toEqual([6]);
  });
});
