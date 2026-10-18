/**
 * @lingfan-video/core 组合根：唯一全知模块。
 * 分层：contracts（端口）← domain（纯域）← app（引擎）← 本文件（装配 + 便利 API）。
 * 实现契约：RenderFn / ValidateFn / ComputeFns。
 */
import type {
  AudioGraph,
  ComputeFns,
  ExportResult,
  Exporter,
  FrameBitmap,
  FrameIndex,
  FrameSink,
  Ms,
  RenderOptions,
  ValidateFn,
} from "@lingfan-video/contracts";
import { validate } from "./domain/validation";
import type { SceneInternal } from "./domain/simulation/types";
import { TimelineEngine, type EngineOptions } from "./app/runtime";

export { makeRenderError } from "./app/runtime/error";
export { TimelineEngine } from "./app/runtime/engine";
export { createInputTrack } from "./app/runtime/input";
export { createRandomStream } from "./domain/random/stream";
export type { EngineOptions, RunSummary } from "./app/runtime/engine-types";
export { validate } from "./domain/validation";
export {
  timestampAt,
  msToFrames,
  framesToMs,
  frameCount,
} from "./domain/time-math/time-math";
export { beatGrid, msPerBeat } from "./domain/time-math/beats";
export { poolOf, loopPool } from "./domain/simulation/types";
/** 音频组合子：能力即上下文的「写法糖」（构造期强类型校验） */
export {
  clip,
  curve,
  fadeIn,
  fadeOut,
  gain,
  loop,
  pan,
  ramp,
  rate,
  warp,
} from "./domain/audio";
export type { SceneInternal, SimNode } from "./domain/simulation/types";

/** 预览/导出通用装配：建引擎 + 装 CPU 位图来源（框架自绘由注入 painter 承载） */
function assemble(opts: RenderOptions): {
  engine: TimelineEngine;
  canvas: HTMLCanvasElement | OffscreenCanvas;
} {
  // 有 painter 时引擎只需要一个占位绘制目标：框架自绘路径不该因为「没有 DOM 画布」而失败。
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    opts.canvas ??
    (opts.painter || opts.headless
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
    input: opts.input,
    seed: opts.seed,
  });
  // 帧像素来源：单一事实来源是宿主画面。注入 painter = 宿主自绘（可同步，也可返回
  // Promise：DOM/Vue/React 栅格化、GPU 读回）；缺省 = 2D 回读；
  // 两者都没有时**不得静默交空白帧**：缺省直接 spec_violation，只有显式 frames:"allow-blank" 才给占位位图。
  if (opts.painter) engine.setFrameSource(opts.painter);
  else
    engine.setPainter(
      readbackPainter(canvas, opts) ?? placeholderPainter(opts),
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

/**
 * 无可用帧像素来源时的占位策略：
 * - 缺省（frames 未声明或 "required"）→ 首帧求值即 `spec_violation`：配置缺失要炸，不能静默交全 0 帧；
 * - 显式 `frames: "allow-blank"` → 全 0 占位位图（预览 sink 自绘、或只关心时间/音频的场合）。
 */
function placeholderPainter(
  opts: RenderOptions,
): (f: FrameIndex, t: Ms) => FrameBitmap {
  if (opts.frames !== "allow-blank")
    return () => {
      throw makeMissingFrameSource();
    };
  return blankPainter(opts);
}

/** 零位图占位（仅 allow-blank 显式选择时使用） */
function blankPainter(
  opts: RenderOptions,
): (f: FrameIndex, t: Ms) => FrameBitmap {
  return () => ({
    data: new Uint8ClampedArray(opts.width * opts.height * 4),
    width: opts.width,
    height: opts.height,
  });
}

function makeMissingFrameSource(): Error {
  const err = new Error(
    "本次 render 需要帧像素，但没有可用的帧来源：既未注入 RenderOptions.painter，" +
      `绘制目标也没有 2D 上下文（canvas.getContext("2d") 不可用；Node 环境通常没有 canvas 实现）。` +
      "不会静默导出空白帧——请注入 painter 或可 2D 的 canvas，若确实不需要像素" +
      '（如预览 sink 自行绘制），显式声明 RenderOptions.frames = "allow-blank"。',
  );
  err.name = "SpecViolation";
  return err;
}

/** render（RenderFn 契约实现）：帧由注入的 sink 逐帧接收；音轨在封装收尾前写入 */
export const render: import("@lingfan-video/contracts").RenderFn = async (
  scene,
  options,
) => {
  const { engine } = assemble(options);
  // 契约已把 exporter 定为必填；此处仍守卫一次，供未类型化的 JS 调用方在首帧前拿到明确报错
  const exporter: Exporter | undefined = options.exporter;
  if (!exporter) throw makeMissingExporter();
  const sink = exporterAdapter(exporter);
  // 预览端（Exporter 的实时实现）与导出共用同一 run；预览声音经 audioOut 边跑边发
  const summary = await engine.run(
    scene as SceneInternal<unknown>,
    sink,
    options.onProgress,
  );
  // 音轨必须在封装收尾之前写入：帧 → 声 → finalize，顺序即封装顺序
  await writeAudioTrack(
    exporter,
    options,
    summary.audioVoices,
    summary.durationMs,
    summary.audioGraph,
  );
  await sink.flushExporter();
  return {
    frames: summary.frames,
    durationMs: summary.durationMs,
    output: await sink.getOutput(),
  };
};

/**
 * 写音轨：程序（登记期 + 运行期声音）→ AudioClock 混合成样本 → exporter.writeAudio。
 * 有声音却没有音轨出口时报错，不静默丢掉声音。
 */
async function writeAudioTrack(
  exporter: Exporter,
  options: RenderOptions,
  voices: readonly import("@lingfan-video/contracts").AudioVoice[],
  durationMs: Ms,
  graph: AudioGraph,
): Promise<void> {
  if (voices.length === 0) return;
  if (!options.audio) {
    // 预览端声音走 audioOutput（实时发声），没有 AudioClock 是正常的
    if (!exporter.writeAudio) return;
    throw Object.assign(
      new Error(
        `场景有 ${voices.length} 个声音，但未注入 RenderOptions.audio（AudioClock）：` +
          "导出器支持音轨时会要求给出混音时钟",
      ),
      { name: "SpecViolation" },
    );
  }
  const write = exporter.writeAudio;
  if (!write)
    throw Object.assign(
      new Error(
        `导出器 ${exporter.impl} 不支持音轨（writeAudio 未实现）：` +
          "有声音的场景请换支持音频的导出器，或去掉 RenderOptions.audio",
      ),
      { name: "SpecViolation" },
    );
  const clock = options.audio;
  const samples = await clock.renderProgram({ durationMs, voices, graph });
  // 块序列自 0 起连续：按序拼接即整轨，布局取自时钟声明（不猜采样率/声道数）
  for (const s of samples)
    await write.call(exporter, s.data, clock.sampleRate, clock.channels);
}

function makeMissingExporter(): Error {
  const err = new Error(
    "render 需要 RenderOptions.exporter：预览传按真实时钟排帧的 Exporter，" +
      "导出传 frames/WebCodecs/FFmpeg 实现；没有渲染后端就没有产物",
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

/**
 * Exporter → FrameSink 适配：引擎直出的真时间戳透传 exporter（变帧率下 index→时间戳非均匀映射）。
 * 封装收尾分两步——引擎调用 finalize（视为「帧已交付完毕」），组合根写完音轨后调 flushExporter
 * 才真正 finalize：音频块必须出现在 moov 之前，所以顺序不能交给两条独立路径各调一次。
 */
function exporterAdapter(exporter: Exporter): FrameSink & {
  flushExporter(): Promise<void>;
  getOutput(): Promise<ExportResult>;
} {
  let delivered = false;
  let output: ExportResult | undefined;
  return {
    writeFrame(
      frame: FrameBitmap,
      _index: FrameIndex,
      timestampMs: Ms,
    ): void | Promise<void> {
      return exporter.writeFrame(frame, timestampMs);
    },
    finalize: async () => {
      delivered = true;
    },
    flushExporter: async () => {
      if (!delivered)
        throw Object.assign(
          new Error("flushExporter 在帧交付完成前调用（组合根内部契约）"),
          { name: "SpecViolation" },
        );
      output = await exporter.finalize();
    },
    getOutput: async () => {
      if (!output)
        throw Object.assign(
          new Error("getOutput 在最终封装前调用（组合根内部契约）"),
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
