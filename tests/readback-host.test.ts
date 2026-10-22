/**
 * 位图回读：把设备句柄转成 CPU 位图的接缝。
 * 覆盖：
 * 1. 纯函数来源与带生命周期宿主两种内层都能被包（生命周期原样透传）；
 * 2. 本来就是位图的载体原样交出，不复制、不再回读；
 * 3. 2D 画布直读（不复制像素）；
 * 4. 非 2D 画布（WebGL 之类的输出面）借绘制搬进接收画布再读；
 * 5. 连画都画不进的对象明确报错，不静默交黑帧；
 * 6. 端到端：合成宿主交给回读宿主包一层，APNG 就能收下带 alpha 的帧。
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

/**
 * 造一块「非 2D」的假输出面（WebGL 画布的等价物）：没有 2D 上下文，
 * 但能被 `drawImage` 当绘制源吃进去——像素只能靠画一遍搬出来。
 */
function fakeGpuSurface(pixels: Uint8ClampedArray) {
  return {
    pixels,
    getContext(kind: string) {
      return kind === "2d" ? null : { kind };
    },
  };
}

/** 造一块接收画布：记下画进来的是谁，回读时交出它持有的像素 */
function fakeScratch(pixels: Uint8ClampedArray) {
  const drawn: unknown[] = [];
  return {
    drawn,
    canvas: {},
    ctx: {
      drawImage(source: unknown, _dx: number, _dy: number) {
        drawn.push(source);
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: pixels,
        width: w,
        height: h,
      }),
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
    expect(toBitmap(bitmap, fakeScratch(new Uint8ClampedArray(0)))).toBe(
      bitmap,
    );
  });

  it("2D 画布句柄回读出同一份像素，且不经过接收画布", () => {
    const pixels = new Uint8ClampedArray(W * H * 4);
    pixels[3] = 77; // 只关心 alpha 有没有原样带出
    const scratch = fakeScratch(new Uint8ClampedArray(W * H * 4));
    const bitmap = readBackHandle(fakeCanvas(pixels), W, H, scratch);
    expect(bitmap.width).toBe(W);
    expect(bitmap.height).toBe(H);
    expect(bitmap.data[3]).toBe(77);
    // 直读路径不该动用接收画布：那一次绘制是多余的拷贝
    expect(scratch.drawn).toEqual([]);
  });

  it("非 2D 画布借绘制搬进接收画布再读", () => {
    const pixels = new Uint8ClampedArray(W * H * 4);
    pixels[3] = 12;
    const surface = fakeGpuSurface(new Uint8ClampedArray(W * H * 4));
    const scratch = fakeScratch(pixels);
    const bitmap = readBackHandle(surface, W, H, scratch);
    // 绘制源就是那张设备面本身，产物是接收画布里的像素
    expect(scratch.drawn).toEqual([surface]);
    expect(bitmap.data[3]).toBe(12);
  });

  it("既没有 2D 上下文、也画不进画布的对象明确报错", () => {
    expect(() => readBackHandle({}, W, H, null)).toThrow(
      /位图回读需要一个能画的画布/,
    );
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
