/**
 * WebCodecs 导出适配器：位图帧怎样交给编码器（视图边界、尺寸校验），
 * 以及编码器的异步 `error` 回调怎样回放到写入调用链。
 *
 * Node 下没有 WebCodecs，这里用假的 `VideoFrame` / `VideoEncoder` 顶替，
 * 只覆盖这两条与像素数据、错误传播有关的路径（编码与封装由 mp4 测试另行覆盖）。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FrameBitmap } from "@lingfan-video/contracts";
import { WebCodecsExporter } from "@lingfan-video/infra";

/** 一次 VideoFrame 构造记录：源（位图视图或句柄）与初始化参数 */
interface FrameCall {
  readonly source: unknown;
  readonly init: Record<string, unknown>;
}

/**
 * 装上假的 WebCodecs 全局。
 *
 * @returns 帧构造记录、编码器实例（可手动触发 error）与恢复函数
 */
function installWebCodecs() {
  /** 每次 VideoFrame 构造的参数 */
  const frames: FrameCall[] = [];
  /** 创建过的编码器（测试里手动触发 error / 放大队列） */
  const encoders: FakeEncoder[] = [];

  class FakeFrame {
    constructor(source: unknown, init: Record<string, unknown>) {
      frames.push({ source, init });
    }
    close(): void {}
  }

  class FakeEncoder {
    /** 编码队列深度；测试可调大以触发背压等待 */
    encodeQueueSize = 0;
    /** 出队回调；适配器持有它来等待队列变浅 */
    ondequeue: (() => void) | null = null;

    constructor(
      private readonly callbacks: {
        readonly output: (...args: unknown[]) => void;
        readonly error: (e: Error) => void;
      },
    ) {
      encoders.push(this);
    }

    configure(): void {}
    encode(): void {}
    async flush(): Promise<void> {}
    close(): void {}

    /** 模拟平台编码器异步报错 */
    emitError(message: string): void {
      this.callbacks.error(new Error(message));
    }
  }

  /** 音频编码器替身：只要不抛错，布局与样本写入路径就能跑通 */
  class FakeAudioEncoder {
    /** 出队回调；适配器持有它来等待队列变浅 */
    ondequeue: (() => void) | null = null;
    /** 编码队列深度（测试保持 0，不触发背压） */
    encodeQueueSize = 0;

    constructor(..._args: unknown[]) {}

    configure(): void {}
    encode(): void {}
    async flush(): Promise<void> {}
    close(): void {}
  }

  /** AudioData 替身：只记录构造参数并允许 close */
  class FakeAudioData {
    constructor(readonly init: Record<string, unknown>) {}
    close(): void {}
  }

  const scope = globalThis as unknown as Record<string, unknown>;
  const previousFrame = scope["VideoFrame"];
  const previousEncoder = scope["VideoEncoder"];
  const previousAudioEncoder = scope["AudioEncoder"];
  const previousAudioData = scope["AudioData"];
  scope["VideoFrame"] = FakeFrame;
  scope["VideoEncoder"] = FakeEncoder;
  scope["AudioEncoder"] = FakeAudioEncoder;
  scope["AudioData"] = FakeAudioData;
  return {
    frames,
    encoders,
    restore: (): void => {
      scope["VideoFrame"] = previousFrame;
      scope["VideoEncoder"] = previousEncoder;
      scope["AudioEncoder"] = previousAudioEncoder;
      scope["AudioData"] = previousAudioData;
    },
  };
}

/** 每个用例后恢复全局（假构造函数不能泄漏给其它测试文件） */
const installed: { restore(): void }[] = [];
afterEach(() => {
  for (const fakes of installed.splice(0)) fakes.restore();
});

/** 装一份假 WebCodecs 并登记清理 */
function webcodecs(): ReturnType<typeof installWebCodecs> {
  const fakes = installWebCodecs();
  installed.push(fakes);
  return fakes;
}

/**
 * 造一块可偏移的位图：数据是更大缓冲的子视图，用来验证 byteOffset 没有被抹掉。
 *
 * @param width 宽（像素）
 * @param height 高（像素）
 * @param pad 前置空闲字节数
 * @returns 位图帧载体
 */
function bitmap(width: number, height: number, pad = 0): FrameBitmap {
  const buffer = new Uint8ClampedArray(pad + width * height * 4);
  return { data: buffer.subarray(pad), width, height };
}

describe("WebCodecs 导出：位图帧", () => {
  it("按数据视图交给编码器：保留 subarray 的 byteOffset/byteLength", async () => {
    const fakes = webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    const frame = bitmap(2, 2, 4);
    await exporter.writeFrame(frame, 0);
    expect(fakes.frames).toHaveLength(1);
    const call = fakes.frames[0]!;
    expect(call.source).toBe(frame.data);
    expect(call.init["codedWidth"]).toBe(2);
    expect(call.init["codedHeight"]).toBe(2);
    expect(call.init["format"]).toBe("RGBA");
  });

  it("尺寸与导出尺寸不一致：写帧前报 spec_violation", async () => {
    webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    await expect(exporter.writeFrame(bitmap(3, 2), 0)).rejects.toMatchObject({
      name: "SpecViolation",
    });
  });

  it("位图数据长度不符：写帧前报 spec_violation", async () => {
    webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    const frame: FrameBitmap = {
      data: new Uint8ClampedArray(12),
      width: 2,
      height: 2,
    };
    await expect(exporter.writeFrame(frame, 0)).rejects.toMatchObject({
      name: "SpecViolation",
    });
  });
});

describe("WebCodecs 导出：编码器异步报错", () => {
  it("error 回调之后：后续写入按同一错误失败，而不是静默继续", async () => {
    const fakes = webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    await exporter.writeFrame(bitmap(2, 2), 0);
    fakes.encoders[0]!.emitError("boom");
    await expect(exporter.writeFrame(bitmap(2, 2), 1)).rejects.toThrow(
      /VideoEncoder 错误：boom/,
    );
  });

  it("等待出队时编码器报错：挂起的写入被唤醒并失败", async () => {
    const fakes = webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    await exporter.writeFrame(bitmap(2, 2), 0);
    /** 队列超过上限，下一次写入会停在背压等待里 */
    const encoder = fakes.encoders[0]!;
    encoder.encodeQueueSize = 17;
    const pending = exporter.writeFrame(bitmap(2, 2), 1);
    encoder.emitError("queue stuck");
    await expect(pending).rejects.toThrow(/VideoEncoder 错误：queue stuck/);
  });
});

describe("WebCodecs 导出：音频布局", () => {
  it("样本数不是声道整数倍的坏块不占布局：之后单声道块正常写入", async () => {
    webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    await expect(
      exporter.writeAudio(new Float32Array(3), 48_000, 2),
    ).rejects.toMatchObject({ name: "SpecViolation" });
    // 坏块若先定下立体声布局，这里会因布局不符而失败
    await expect(
      exporter.writeAudio(new Float32Array(8), 48_000, 1),
    ).resolves.toBeUndefined();
  });
});

describe("WebCodecs 导出：收尾失败可重试", () => {
  it("无帧时 finalize 失败不影响后续写入", async () => {
    webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    await expect(exporter.finalize()).rejects.toThrow(/无已编码帧/);
    await expect(exporter.writeFrame(bitmap(2, 2), 0)).resolves.toBeUndefined();
  });

  it("收尾失败后同一实例仍可再次收尾与写入", async () => {
    webcodecs();
    const exporter = new WebCodecsExporter({ width: 2, height: 2, fps: 30 });
    await exporter.writeFrame(bitmap(2, 2), 0);
    // 假编码器不吐 decoderConfig，收尾卡在参数集检查；关键是失败不把实例锁死
    await expect(exporter.finalize()).rejects.toThrow(/AVC/);
    await expect(exporter.finalize()).rejects.toThrow(/AVC/);
    await expect(exporter.writeFrame(bitmap(2, 2), 1)).resolves.toBeUndefined();
  });
});
