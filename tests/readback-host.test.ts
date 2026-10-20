/**
 * 位图回读：把设备句柄转成 CPU 位图的接缝。
 * 覆盖：
 * 1. 纯函数来源与带生命周期宿主两种内层都能被包（生命周期原样透传）；
 * 2. 本来就是位图的载体原样交出，不复制、不再回读；
 * 3. 拿不到 2D 上下文的设备明确报错，不静默交黑帧；
 * 4. 端到端：合成宿主交给回读宿主包一层，APNG 就能收下带 alpha 的帧。
 */
import { describe, expect, it } from "vitest";
import type {
  FrameBitmap,
  FrameHost,
  FrameHostInfo,
  FrameIndex,
  Ms,
} from "@lingfan-video/contracts";
import {
  ApngExporter,
  createReadbackHost,
  readBackHandle,
  toBitmap,
} from "@lingfan-video/infra";

const W = 4;
const H = 2;

/** 造一块只满足 2D 回读最小面的假画布 */
function fakeCanvas(pixels: Uint8ClampedArray) {
  return {
    getContext(kind: string) {
      if (kind !== "2d") return null;
      return {
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: pixels,
          width: w,
          height: h,
        }),
      };
    },
  };
}

describe("位图回读", () => {
  it("位图载体原样交出（不复制、不回读）", () => {
    const bitmap: FrameBitmap = {
      data: new Uint8ClampedArray(W * H * 4),
      width: W,
      height: H,
    };
    expect(toBitmap(bitmap)).toBe(bitmap);
  });

  it("2D 画布句柄回读出同一份像素", () => {
    const pixels = new Uint8ClampedArray(W * H * 4);
    pixels[3] = 77; // 只关心 alpha 有没有原样带出
    const bitmap = readBackHandle(fakeCanvas(pixels), W, H);
    expect(bitmap.width).toBe(W);
    expect(bitmap.height).toBe(H);
    expect(bitmap.data[3]).toBe(77);
  });

  it("非 2D 设备明确报错，而不是交一张黑帧", () => {
    expect(() => readBackHandle({}, W, H)).toThrow(/位图回读需要 2D 画布/);
  });

  it("包装带生命周期的宿主时，begin/close 原样透传", async () => {
    const calls: string[] = [];
    const infos: FrameHostInfo[] = [];
    const inner: FrameHost = {
      begin(info) {
        calls.push("begin");
        infos.push(info);
      },
      frame(_frame: FrameIndex, _t: Ms) {
        return {
          kind: "handle",
          native: fakeCanvas(new Uint8ClampedArray(W * H * 4)),
          width: W,
          height: H,
          close() {},
        };
      },
      close() {
        calls.push("close");
      },
    };

    const wrapped = createReadbackHost(inner);
    const info: FrameHostInfo = {
      fps: 10,
      width: W,
      height: H,
      durationMs: 100,
      headless: true,
      alpha: "alpha",
    };
    await wrapped.begin(info);
    const carrier = await wrapped.frame(0, 0);
    await wrapped.close?.();

    expect(calls).toEqual(["begin", "close"]);
    // 透明度声明也一并透传：内层宿主据此决定清成哪种干净画布
    expect(infos[0]!.alpha).toBe("alpha");
    expect(carrier.kind).not.toBe("handle");
  });

  it("端到端：回读后的帧能被 APNG 收下，alpha 落进产物", async () => {
    const pixels = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels[i + 3] = 40;
    const source = () => ({
      kind: "handle" as const,
      native: fakeCanvas(pixels),
      width: W,
      height: H,
      close() {},
    });

    const exporter = new ApngExporter({ width: W, height: H });
    const host = createReadbackHost(source);
    await host.begin({
      fps: 10,
      width: W,
      height: H,
      durationMs: 100,
      headless: true,
      alpha: "alpha",
    });
    await exporter.writeFrame(await host.frame(0, 0), 0);
    const result = await exporter.finalize();

    expect(result.format).toBe("apng");
    expect(result.frames).toBe(1);
  });
});
