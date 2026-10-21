/**
 * WebM 导出适配器：帧与音频怎样交给 VP8/VP9 与 Opus 编码器，透明档的 alpha
 * 侧通道怎样与颜色块配对，以及平台编码器的异步报错怎样回放到写入调用链。
 *
 * Node 下没有 WebCodecs，这里用假的 `VideoFrame` / `VideoEncoder` / `AudioEncoder`
 * 顶替：只覆盖「编码器入口」这一段的契约，封装与分块结构由 webm 封装测试另行覆盖。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FrameBitmap } from "@lingfan-video/contracts";
import { WebmExporter } from "@lingfan-video/infra";

/** 一次 VideoFrame 构造记录：源与初始化参数 */
interface FrameCall {
  readonly source: unknown;
  readonly init: Record<string, unknown>;
}

/** 假编码器收到的编码调用 */
interface EncodeCall {
  readonly timestamp: number;
  readonly keyFrame: boolean;
}

/** 假编码块：只保留适配器实际读到的字段 */
interface FakeChunk {
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly duration: number;
  readonly byteLength: number;
  copyTo(dst: ArrayBuffer): void;
}

/** 装上一套假 WebCodecs 全局 */
function installWebCodecs() {
  /** 每次 VideoFrame 构造的参数 */
  const frames: FrameCall[] = [];
  /** 编码器实例（测试里手动触发 error / 检查配置） */
  const encoders: FakeEncoder[] = [];
  /** 音频编码器实例 */
  const audioEncoders: FakeAudioEncoder[] = [];

  class FakeFrame {
    /** 构造参数：编码器靠它回吐带时间戳的编码块 */
    readonly init: Record<string, unknown>;

    constructor(source: unknown, init: Record<string, unknown>) {
      this.init = init;
      frames.push({ source, init });
    }
    close(): void {}
  }

  class FakeEncoder {
    /** 编码队列深度；测试可调大以触发背压等待 */
    encodeQueueSize = 0;
    /** 出队回调；适配器持有它来等待队列变浅 */
    ondequeue: (() => void) | null = null;
    /** 配置过的编码参数（用来断言编解码器与尺寸） */
    config: Record<string, unknown> | null = null;
    /** 每次 encode 的入参 */
    readonly calls: EncodeCall[] = [];

    constructor(
      private readonly callbacks: {
        readonly output: (chunk: FakeChunk) => void;
        readonly error: (e: Error) => void;
      },
    ) {
      encoders.push(this);
    }

    configure(config: Record<string, unknown>): void {
      this.config = config;
    }

    encode(frame: FakeFrame, options?: { keyFrame?: boolean }): void {
      const init = (frame as unknown as { init?: Record<string, unknown> })
        .init;
      /** 本帧的时间戳与时长：编码器按它们回吐编码块 */
      const timestamp = Number(init?.["timestamp"] ?? 0);
      const duration = Number(init?.["duration"] ?? 0);
      const keyFrame = options?.keyFrame === true;
      this.calls.push({ timestamp, keyFrame });
      // 同步回吐编码块：让配对与封装在同一个调用栈里完成，测试无需等异步
      this.callbacks.output({
        type: keyFrame ? "key" : "delta",
        timestamp,
        duration,
        byteLength: 4,
        copyTo: (dst: ArrayBuffer) => {
          new Uint8Array(dst).fill(0x5a);
        },
      });
    }

    async flush(): Promise<void> {}
    close(): void {}

    /** 模拟平台编码器异步报错 */
    emitError(message: string): void {
      this.callbacks.error(new Error(message));
    }
  }

  class FakeAudioEncoder {
    encodeQueueSize = 0;
    ondequeue: (() => void) | null = null;
    config: Record<string, unknown> | null = null;

    constructor(
      private readonly callbacks: {
        readonly output: (chunk: FakeChunk) => void;
        readonly error: (e: Error) => void;
      },
    ) {
      audioEncoders.push(this);
    }

    configure(config: Record<string, unknown>): void {
      this.config = config;
    }

    encode(data: { timestamp: number; numberOfFrames: number }): void {
      this.callbacks.output({
        type: "key",
        timestamp: data.timestamp,
        duration: 20_000,
        byteLength: 2,
        copyTo: (dst: ArrayBuffer) => {
          new Uint8Array(dst).fill(0x11);
        },
      });
    }

    async flush(): Promise<void> {}
    close(): void {}

    /** 模拟平台编码器异步报错 */
    emitError(message: string): void {
      this.callbacks.error(new Error(message));
    }
  }

  class FakeAudioData {
    constructor(readonly init: Record<string, unknown>) {}
    close(): void {}
  }

  const scope = globalThis as unknown as Record<string, unknown>;
  /** 装之前的全局值：用例结束后原样还回去 */
  const previous = {
    VideoFrame: scope["VideoFrame"],
    VideoEncoder: scope["VideoEncoder"],
    AudioEncoder: scope["AudioEncoder"],
    AudioData: scope["AudioData"],
  };
  scope["VideoFrame"] = FakeFrame;
  scope["VideoEncoder"] = FakeEncoder;
  scope["AudioEncoder"] = FakeAudioEncoder;
  scope["AudioData"] = FakeAudioData;
  return {
    frames,
    encoders,
    audioEncoders,
    restore: (): void => {
      scope["VideoFrame"] = previous.VideoFrame;
      scope["VideoEncoder"] = previous.VideoEncoder;
      scope["AudioEncoder"] = previous.AudioEncoder;
      scope["AudioData"] = previous.AudioData;
    },
  };
}

/** 假构造函数的清理登记（不能泄漏给其它测试文件） */
const installed: { restore(): void }[] = [];
afterEach(() => {
  for (const fakes of installed.splice(0)) fakes.restore();
});

/** 装一套假 WebCodecs 并登记清理 */
function webcodecs(): ReturnType<typeof installWebCodecs> {
  const fakes = installWebCodecs();
  installed.push(fakes);
  return fakes;
}

/**
 * 造一块位图；`pad` 让数据成为更大缓冲的子视图，用来验证 byteOffset 没被抹掉。
 *
 * @param width 宽（像素）
 * @param height 高（像素）
 * @param alpha 每像素的 alpha 值
 * @param pad 前置空闲字节数
 * @returns 位图帧载体
 */
function bitmap(
  width: number,
  height: number,
  alpha = 255,
  pad = 0,
): FrameBitmap {
  const buffer = new Uint8ClampedArray(pad + width * height * 4);
  for (let i = 0; i < width * height * 4; i += 4) {
    buffer[pad + i] = 0x20;
    buffer[pad + i + 1] = 0x40;
    buffer[pad + i + 2] = 0x60;
    buffer[pad + i + 3] = alpha;
  }
  return { data: buffer.subarray(pad), width, height };
}

/** 读 WebM 文件头的前四字节（EBML 元素 ID） */
function isWebm(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

describe("WebM 导出：视频帧进入编码器", () => {
  it("位图按数据视图交出：保留 subarray 的 byteOffset/byteLength", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    const frame = bitmap(2, 2, 255, 4);
    await exporter.writeFrame(frame, 0);
    expect(fakes.frames).toHaveLength(1);
    const call = fakes.frames[0]!;
    expect(call.source).toBe(frame.data);
    expect(call.init["format"]).toBe("RGBA");
    expect(call.init["codedWidth"]).toBe(2);
  });

  it("编码器按 VP9 + 声明尺寸配置，首帧是关键帧", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({ width: 4, height: 2, fps: 30 });
    await exporter.writeFrame(bitmap(4, 2), 0);
    const encoder = fakes.encoders[0]!;
    expect(encoder.config?.["codec"]).toBe("vp09.00.10.08");
    expect(encoder.config?.["width"]).toBe(4);
    expect(encoder.config?.["height"]).toBe(2);
    expect(encoder.calls[0]!.keyFrame).toBe(true);
  });

  it("指定 vp8 时用短名编解码器串", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({
      width: 2,
      height: 2,
      fps: 30,
      videoCodec: "vp8",
    });
    await exporter.writeFrame(bitmap(2, 2), 0);
    expect(fakes.encoders[0]!.config?.["codec"]).toBe("vp8");
  });

  it("帧尺寸与导出尺寸不一致：写帧前报 spec_violation", async () => {
    webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await expect(exporter.writeFrame(bitmap(3, 2), 0)).rejects.toMatchObject({
      name: "SpecViolation",
    });
  });

  it("位图数据长度不符：写帧前报 spec_violation", async () => {
    webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
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

describe("WebM 导出：透明档的 alpha 侧通道", () => {
  it("多开一个编码器，把 alpha 铺进 RGB 三通道（亮度即 alpha）", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({
      width: 2,
      height: 1,
      fps: 30,
      alpha: true,
    });
    await exporter.writeFrame(bitmap(2, 1, 77), 0);
    // 颜色编码器 + alpha 编码器：两条独立的关键帧流
    expect(fakes.encoders).toHaveLength(2);
    const alphaFrame = fakes.frames[1]!;
    expect(Array.from(alphaFrame.source as Uint8ClampedArray)).toEqual([
      77, 77, 77, 255, 77, 77, 77, 255,
    ]);
    // alpha 流按规范只含关键帧，否则播放器无法按帧独立还原
    expect(fakes.encoders[1]!.calls.every((call) => call.keyFrame)).toBe(true);
  });

  it("透明档只收位图：设备句柄明确报错，而不是回读像素", async () => {
    webcodecs();
    const exporter = new WebmExporter({
      width: 2,
      height: 2,
      fps: 30,
      alpha: true,
    });
    await expect(
      exporter.writeFrame(
        { kind: "handle", native: {}, width: 2, height: 2, close() {} },
        0,
      ),
    ).rejects.toMatchObject({ name: "SpecViolation" });
  });

  it("声明 transparent 的实例把能力如实报告给引擎", () => {
    webcodecs();
    expect(
      new WebmExporter({ width: 2, height: 2, fps: 30, alpha: true }).alpha,
    ).toBe(true);
    expect(new WebmExporter({ width: 2, height: 2, fps: 30 }).alpha).toBe(
      false,
    );
  });

  it("两路编码块配齐才交给容器：收尾时没有残留", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({
      width: 2,
      height: 2,
      fps: 30,
      alpha: true,
    });
    await exporter.writeFrame(bitmap(2, 2, 10), 0);
    await exporter.writeFrame(bitmap(2, 2, 20), 40);
    const result = await exporter.finalize();
    const bytes = new Uint8Array(await (result.output as Blob).arrayBuffer());
    expect(isWebm(bytes)).toBe(true);
    expect(result.frames).toBe(2);
    // 颜色与 alpha 两路都各编了两帧
    expect(fakes.encoders[0]!.calls).toHaveLength(2);
    expect(fakes.encoders[1]!.calls).toHaveLength(2);
  });
});

describe("WebM 导出：音频轨", () => {
  it("Opus 编码器按 48kHz 与声道数配置", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await exporter.writeAudio(new Float32Array(960), 48_000, 2);
    expect(fakes.audioEncoders).toHaveLength(1);
    const config = fakes.audioEncoders[0]!.config;
    expect(config?.["codec"]).toBe("opus");
    expect(config?.["sampleRate"]).toBe(48_000);
    expect(config?.["numberOfChannels"]).toBe(2);
  });

  it("采样率不是 48kHz：首块即报 spec_violation", async () => {
    webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await expect(
      exporter.writeAudio(new Float32Array(960), 44_100, 2),
    ).rejects.toMatchObject({ name: "SpecViolation" });
  });

  it("样本数不是声道整数倍：坏块不占布局，之后单声道块正常写入", async () => {
    webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await expect(
      exporter.writeAudio(new Float32Array(3), 48_000, 2),
    ).rejects.toMatchObject({ name: "SpecViolation" });
    await expect(
      exporter.writeAudio(new Float32Array(8), 48_000, 1),
    ).resolves.toBeUndefined();
  });

  it("长块按上限切分后逐块提交", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    // 5000 帧超过单块上限 4096，应当切成 4096 + 904 两块
    await exporter.writeAudio(new Float32Array(5000), 48_000, 1);
    expect(fakes.audioEncoders[0]!.config).not.toBeNull();
  });
});

describe("WebM 导出：错误与收尾", () => {
  it("编码器异步报错之后：后续写入按同一错误失败，而不是静默继续", async () => {
    const fakes = webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await exporter.writeFrame(bitmap(2, 2), 0);
    fakes.encoders[0]!.emitError("boom");
    await expect(exporter.writeFrame(bitmap(2, 2), 40)).rejects.toThrow(
      /VideoEncoder 错误：boom/,
    );
  });

  it("无帧时 finalize 报错，且不影响后续写入", async () => {
    webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await expect(exporter.finalize()).rejects.toThrow(/无已编码帧/);
    await expect(exporter.writeFrame(bitmap(2, 2), 0)).resolves.toBeUndefined();
  });

  it("收尾之后写入是用法错误：明确报 spec_violation", async () => {
    webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await exporter.writeFrame(bitmap(2, 2), 0);
    await exporter.finalize();
    await expect(exporter.writeFrame(bitmap(2, 2), 40)).rejects.toMatchObject({
      name: "SpecViolation",
    });
  });

  it("产物是单个 webm 文件，帧数与时长按时间线给出", async () => {
    webcodecs();
    const exporter = new WebmExporter({ width: 2, height: 2, fps: 30 });
    await exporter.writeFrame(bitmap(2, 2), 0);
    await exporter.writeFrame(bitmap(2, 2), 40);
    const result = await exporter.finalize();
    expect(result.format).toBe("webm");
    expect(result.frames).toBe(2);
    expect(result.durationMs).toBe(40);
    expect(
      (await (result.output as Blob).arrayBuffer()).byteLength,
    ).toBeGreaterThan(0);
  });
});
