/**
 * @lingfan-video/core 组合根：唯一全知模块。
 * 分层：contracts（端口）← domain（纯域）← app（引擎）← 本文件（装配 + 便利 API）。
 * 实现契约：RenderFn / ValidateFn / ComputeFns。
 */
import type {
  ComputeFns,
  ExportResult,
  FrameBitmap,
  FrameIndex,
  FrameSink,
  Ms,
  RenderOptions,
  RenderResult,
  Scene,
  ValidateFn,
} from "@lingfan-video/contracts";
import { msToFrames, timestampAt } from "./domain/time-math/time-math";
import { validate } from "./domain/validation";
import type { SceneInternal } from "./domain/simulation/types";
import { TimelineEngine, type EngineOptions } from "./app/runtime";

export { makeRenderError } from "./app/runtime/error";
export { TimelineEngine } from "./app/runtime/engine";
export type { EngineOptions, RunSummary } from "./app/runtime/engine-types";
export { validate } from "./domain/validation";
export {
  timestampAt,
  msToFrames,
  framesToMs,
  frameCount,
} from "./domain/time-math/time-math";
export { poolOf, loopPool } from "./domain/simulation/types";
/** 音频组合子：能力即上下文的「写法糖」（构造期强类型校验） */
export { clip, gain, pan, loop, rate, warp } from "./domain/audio";
export type { SceneInternal, SimNode } from "./domain/simulation/types";

/** 预览/导出通用装配：建引擎 + 装 CPU 位图来源（GPU painter 由独立适配器承载） */
function assemble(opts: RenderOptions): {
  engine: TimelineEngine;
  canvas: HTMLCanvasElement | OffscreenCanvas;
} {
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    opts.canvas ??
    (opts.headless
      ? makeHeadlessCanvas(opts.width, opts.height)
      : document.createElement("canvas"));
  const engine = new TimelineEngine({
    fps: opts.fps,
    width: opts.width,
    height: opts.height,
    canvas,
    headless: opts.headless ?? false,
    assets: opts.assets ?? makeDefaultAssets(),
    audioOut: opts.audioOutput,
  });
  // 帧像素来源：单一事实来源是绘制目标本身（step 回调画在 canvas 上，帧从画布回读）。
  // 注入 painter = GPU/离屏/自定义合成路径自绘；缺省 = 2D 回读；无 2D 上下文（Node 无 canvas 实现）
  // 时退回零位图，保证模拟与计时仍可跑（此时导出帧为空白，属配置缺失而非静默错误）。
  engine.setPainter(
    opts.painter ?? readbackPainter(canvas, opts) ?? blankPainter(opts),
  );
  return { engine, canvas };
}

/** 从绘制目标的 2D 上下文回读整帧（每帧一次，不缓存对象） */
function readbackPainter(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  opts: RenderOptions,
): ((f: FrameIndex, t: Ms) => FrameBitmap) | null {
  if (typeof canvas.getContext !== "function") return null;
  const ctx = canvas.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx || typeof ctx.getImageData !== "function") return null;
  return () => {
    const image = ctx.getImageData(0, 0, opts.width, opts.height);
    return { data: image.data, width: image.width, height: image.height };
  };
}

/** 无绘制后端时的占位位图（全 0） */
function blankPainter(
  opts: RenderOptions,
): (f: FrameIndex, t: Ms) => FrameBitmap {
  return () => ({
    data: new Uint8ClampedArray(opts.width * opts.height * 4),
    width: opts.width,
    height: opts.height,
  });
}

/** render（RenderFn 契约实现）：exporter 注入 = 导出模式；缺省 = 预览模式 */
export const render: import("@lingfan-video/contracts").RenderFn = async (
  scene,
  options,
) => {
  const { engine } = assemble(options);
  const exporter = options.exporter;
  if (!exporter) {
    // 预览模式缺省未实装（实时呈现由宿主用 paced sink 装配，见 examples/browser）；导出走注入的 exporter
    throw makeMissingExporter();
  }
  const sink = exporterAdapter(exporter);
  // 预览端（paced sink）与导出共用同一 run；预览声音经 audioOut 边跑边发
  const summary = await engine.run(
    scene as SceneInternal<unknown>,
    sink,
    options.onProgress,
  );
  // 音频：程序（登记期 + 运行期声音）→ AudioClock 混音 → exporter.writeAudio（缺省 = 纯视频导出）
  if (options.audio && summary.audioVoices.length > 0 && exporter.writeAudio) {
    const clock = options.audio;
    const samples = await clock.renderProgram({
      durationMs: summary.durationMs,
      voices: summary.audioVoices,
    });
    // 块序列自 0 起连续：按序拼接即整轨，布局取自时钟声明（不猜采样率/声道数）
    for (const s of samples)
      await exporter.writeAudio(s.data, clock.sampleRate, clock.channels);
  }
  return {
    frames: summary.frames,
    durationMs: summary.durationMs,
    output: await sink.getOutput(),
  };
};

function makeMissingExporter(): Error {
  const err = new Error(
    "RenderOptions.exporter 缺省：预览模式未实装；导出请注入 exporter",
  );
  err.name = "SpecViolation";
  return err;
}

/** headless 画布：Node 无 OffscreenCanvas 全局 → 最小桩（模拟求值不触 canvas API；GPU 适配器要求真画布） */
function makeHeadlessCanvas(
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height);
  return { width, height } as unknown as OffscreenCanvas;
}

/** Exporter → FrameSink 适配：引擎直出的真时间戳透传 exporter（变帧率下 index→时间戳非均匀映射）；ExportResult 经 getOutput 恰好一次取回 */
function exporterAdapter(
  exporter: NonNullable<RenderOptions["exporter"]>,
): FrameSink & { getOutput(): Promise<ExportResult> } {
  let output: ExportResult | undefined;
  return {
    writeFrame(
      frame: FrameBitmap,
      index: FrameIndex,
      timestampMs: Ms,
    ): void | Promise<void> {
      return exporter.writeFrame(frame, timestampMs);
    },
    finalize: async () => {
      output = await exporter.finalize();
    },
    getOutput: async () => {
      if (!output)
        throw Object.assign(
          new Error("getOutput 在 finalize 前调用（组合根内部契约）"),
          { name: "SpecViolation" },
        );
      return output;
    },
  };
}

/** validate（ValidateFn 契约实现） */
export const validateScene: ValidateFn = (scene) =>
  validate(scene as SceneInternal<unknown>, 60);

/** computeAt/computeRange（ComputeFns 契约实现）：同一次登记复用（登记不重跑） */
export const compute: ComputeFns = {
  computeAt: async (scene, t) => {
    const engine = new TimelineEngine(engineOptsForCompute());
    return engine.stateAt(scene as SceneInternal<unknown>, t);
  },
  computeRange: async (scene, from, to) => {
    const engine = new TimelineEngine(engineOptsForCompute());
    return engine.collect(scene as SceneInternal<unknown>, from, to);
  },
};

/** compute 专用装配：headless、无 painter（只做模拟求值，不产位图） */
function engineOptsForCompute(): EngineOptions {
  return {
    fps: 60,
    width: 1,
    height: 1,
    canvas: null as unknown as HTMLCanvasElement,
    headless: true,
    assets: makeDefaultAssets(),
  };
}

/** 默认资产来源：无平台后端 → fail-fast（真实解码由平台适配器承载，注入自定义实现即可替换） */
function makeDefaultAssets(): import("@lingfan-video/contracts").AssetSource {
  return {
    load: (url: string) => {
      throw new Error(
        `assets.load('${url}')：组合根未注入 AssetSource；请注入自定义实现`,
      );
    },
  };
}

/** 便利重导出：start（StartFn 三重载）从 dsl 出 */
export { startScene as start } from "./domain/simulation/dsl";
export type { StartSpec } from "./domain/simulation/dsl";
export { createScene } from "./domain/simulation/dsl";
