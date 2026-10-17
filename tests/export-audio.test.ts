/**
 * 导出链路音轨接线：帧 → 声 → finalize 的顺序、布局取自 AudioClock 声明、
 * 有声音却缺出口/缺时钟时报错而不是静默丢声。
 */
import { describe, expect, it } from "vitest";
import {
  TimelineEngine,
  clip,
  createScene,
  gain,
  render,
  start,
} from "@lingfan-video/core";
import { MemoryFrameSink } from "@lingfan-video/infra";
import type {
  AudioSample,
  Exporter,
  ExportResult,
  RenderOptions,
} from "@lingfan-video/contracts";

/** 记录调用顺序的导出器：只验时序与数据，不编码 */
class RecordingExporter implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  readonly calls: string[] = [];
  readonly audio: { frames: number; sampleRate: number; channels: number }[] =
    [];
  frames = 0;

  async writeFrame(): Promise<void> {
    this.frames += 1;
    if (!this.calls.includes("frames")) this.calls.push("frames");
  }

  async writeAudio(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
  ): Promise<void> {
    this.calls.push("audio");
    this.audio.push({
      frames: samples.length / channels,
      sampleRate,
      channels,
    });
  }

  async finalize(): Promise<ExportResult> {
    this.calls.push("finalize");
    return { output: "", frames: this.frames, durationMs: 0, format: "frames" };
  }
}

/** 只有帧出口的导出器（模拟 FrameSequenceExporter 不支持音轨） */
class SilentExporter implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  async writeFrame(): Promise<void> {}
  async finalize(): Promise<ExportResult> {
    return { output: "", frames: 0, durationMs: 0, format: "frames" };
  }
}

/** 只有一个声音的剧本：登记期声明（1000ms 场景内发声） */
function sceneWithOneSound() {
  return start(1000, (env) => {
    env.step(1000, (ctx) => {
      // 运行期发射按调用计：脚本用守卫保证只发一次（每帧都会回调）
      if (ctx.frameIndex === 0) ctx.audio(clip("boom"), { gain: gain(0.5) });
    });
  });
}

const scene = sceneWithOneSound();

const clock = {
  sampleRate: 48_000,
  channels: 2,
  async renderProgram(program: {
    durationMs: number;
    voices: readonly unknown[];
  }): Promise<AudioSample[]> {
    // 一块 = 整轨（布局随声明）
    const frames = Math.ceil((program.durationMs / 1000) * 48_000);
    return [{ data: new Float32Array(frames * 2), atMs: 0 }];
  },
  async decode() {
    throw new Error("未使用");
  },
};

async function withPainter(
  exporter: Exporter,
  options: Partial<RenderOptions>,
) {
  return render(scene, {
    fps: 30,
    width: 4,
    height: 4,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
    painter: () => ({
      data: new Uint8ClampedArray(4 * 4 * 4),
      width: 4,
      height: 4,
    }),
    ...options,
    exporter,
  });
}

describe("导出音轨接线", () => {
  it("帧全部写完后才写音频块，音频写完才 finalize", async () => {
    const exporter = new RecordingExporter();
    const result = await withPainter(exporter, { audio: clock });
    expect(result.frames).toBe(30);
    expect(exporter.frames).toBe(30);
    expect(exporter.calls).toEqual(["frames", "audio", "finalize"]);
    expect(exporter.audio).toEqual([
      { frames: 48_000, sampleRate: 48_000, channels: 2 },
    ]);
  });

  it("无声音时不调用 writeAudio（纯视频导出）", async () => {
    const silentScene = start(100, (env) => {
      env.step(100, () => {});
    });
    const exporter = new RecordingExporter();
    await render(silentScene, {
      fps: 30,
      width: 4,
      height: 4,
      canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
      headless: true,
      exporter,
      audio: clock,
    });
    expect(exporter.calls).toEqual(["frames", "finalize"]);
  });

  it("有声音但导出器不支持音轨 → spec_violation", async () => {
    const exporter = new SilentExporter();
    await expect(withPainter(exporter, { audio: clock })).rejects.toMatchObject(
      { name: "SpecViolation" },
    );
  });

  it("有声音但没有 AudioClock → spec_violation", async () => {
    const exporter = new RecordingExporter();
    await expect(withPainter(exporter, {})).rejects.toMatchObject({
      name: "SpecViolation",
    });
  });
});

describe("引擎侧声音收集与内存导出器共存", () => {
  it("MemoryFrameSink 场景仍可只导出帧", async () => {
    const engine = new TimelineEngine({
      fps: 30,
      width: 4,
      height: 4,
      canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
      headless: true,
    });
    engine.setPainter(() => ({
      data: new Uint8ClampedArray(4 * 4 * 4),
      width: 4,
      height: 4,
    }));
    const sink = new MemoryFrameSink();
    const summary = await engine.run(scene as never, sink);
    expect(summary.frames).toBe(30);
    expect(summary.audioVoices.length).toBe(1);
  });
});
