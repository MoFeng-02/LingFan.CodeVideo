/**
 * 帧宿主生命周期：有状态宿主（物理、粒子池、第三方引擎时钟）必须能安全重播。
 * 覆盖：
 * 1. begin → frame×N → close 的顺序与参数；
 * 2. 每次推演都重新 begin：重播不会沿用上一次的跨帧状态；
 * 3. begin 失败即整个推演失败（不交帧、不调 close）；
 * 4. close 失败不得掩盖推演失败（两个错误都交回调用方）。
 */
import { describe, expect, it } from "vitest";
import { render, start } from "@lingfan-video/core";
import type {
  FrameBitmap,
  FrameHost,
  FrameHostInfo,
} from "@lingfan-video/contracts";
import { FrameSequenceExporter } from "@lingfan-video/infra";

const W = 8;
const H = 4;
const FPS = 10;
const DURATION_MS = 300;
const FRAMES = (DURATION_MS / 1000) * FPS;

function paintScene() {
  return start(DURATION_MS, (env) => {
    env.step(DURATION_MS, () => {});
  });
}

function bitmap(red: number): FrameBitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = red;
    data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}

/** 记录调用顺序，并把内部计数写进像素（没重置就会串状态） */
function recordingHost() {
  const calls: string[] = [];
  const infos: FrameHostInfo[] = [];
  let counter = 0;
  const host: FrameHost = {
    begin(info) {
      calls.push("begin");
      infos.push(info);
      counter = 0;
    },
    frame() {
      calls.push("frame");
      return bitmap(counter++);
    },
    close() {
      calls.push("close");
    },
  };
  return { host, calls, infos };
}

describe("帧宿主生命周期", () => {
  it("begin → frame×N → close，参数是一次推演的固定信息", async () => {
    const { host, calls, infos } = recordingHost();
    const exporter = new FrameSequenceExporter();
    const result = await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter,
      painter: host,
    });
    expect(result.frames).toBe(FRAMES);
    expect(calls[0]).toBe("begin");
    expect(calls.at(-1)).toBe("close");
    expect(calls.filter((c) => c === "frame")).toHaveLength(FRAMES);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({
      fps: FPS,
      width: W,
      height: H,
      durationMs: DURATION_MS,
      headless: false,
    });
    expect(exporter.frames[0]!.data[0]).toBe(0);
  });

  it("重播会重新 begin：跨帧状态不串到下一段推演", async () => {
    const { host, infos } = recordingHost();
    const first = new FrameSequenceExporter();
    const second = new FrameSequenceExporter();
    await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter: first,
      painter: host,
    });
    await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter: second,
      painter: host,
    });
    expect(infos).toHaveLength(2);
    expect(second.frames[0]!.data[0]).toBe(0);
    expect(second.frames.map((f) => f.data[0])).toEqual(
      first.frames.map((f) => f.data[0]),
    );
  });

  it("begin 失败：整个推演失败，不交帧也不调 close", async () => {
    const calls: string[] = [];
    const host: FrameHost = {
      begin() {
        calls.push("begin");
        throw new Error("宿主建场失败：WebGL 上下文创建失败");
      },
      frame() {
        calls.push("frame");
        return bitmap(0);
      },
      close() {
        calls.push("close");
      },
    };
    const exporter = new FrameSequenceExporter();
    await expect(
      render(paintScene(), {
        fps: FPS,
        width: W,
        height: H,
        exporter,
        painter: host,
      }),
    ).rejects.toThrow(/WebGL 上下文创建失败/);
    expect(calls).toEqual(["begin"]);
    expect(exporter.frames).toHaveLength(0);
  });

  it("close 失败：错误交回调用方，已交的帧不丢", async () => {
    const host: FrameHost = {
      begin() {},
      frame: () => bitmap(0),
      close() {
        throw new Error("宿主收场失败：渲染器没释放");
      },
    };
    const exporter = new FrameSequenceExporter();
    await expect(
      render(paintScene(), {
        fps: FPS,
        width: W,
        height: H,
        exporter,
        painter: host,
      }),
    ).rejects.toThrow(/渲染器没释放/);
    expect(exporter.frames).toHaveLength(FRAMES);
  });

  it("推演失败且 close 失败：两个错误都要交回（AggregateError）", async () => {
    let frames = 0;
    const host: FrameHost = {
      begin() {},
      frame: () => {
        if (frames++ === 1) throw new Error("宿主取帧失败：纹理丢帧");
        return bitmap(0);
      },
      close() {
        throw new Error("宿主收场失败：设备丢失");
      },
    };
    const exporter = new FrameSequenceExporter();
    const error = await render(paintScene(), {
      fps: FPS,
      width: W,
      height: H,
      exporter,
      painter: host,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const messages = (error as AggregateError).errors.map((item) =>
      item instanceof Error ? item.message : String(item),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/纹理丢帧/);
    expect(messages[1]).toMatch(/设备丢失/);
    expect(exporter.frames).toHaveLength(1);
  });
});
