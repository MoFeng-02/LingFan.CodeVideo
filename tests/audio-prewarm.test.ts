/**
 * 音频预热：页面加载时先编译音频程序并合成 PCM，点播放就不再现场算整条配乐。
 *
 * 两类断言：
 * 1. `compileAudioProgram` 与 `render` 走同一条登记/编译路径，得到的程序逐项相同
 *    （数量、id、起点、剪辑/合成参数、增益、总线），且同一场景重复编译结果一致；
 * 2. `WebAudioOutput.warm` 只填 PCM 缓存：不需要 AudioWorklet、不移动时间线锚点，
 *    重复调用不重复加载素材。
 */
import { describe, expect, it } from "vitest";
import type {
  AudioOutput,
  AudioProgram,
  AudioVoice,
  ExportResult,
  Exporter,
  LiveVoice,
  Ms,
  Scene,
} from "@lingfan-video/contracts";
import {
  clip,
  compileAudioProgram,
  createScene,
  gain,
  render,
} from "@lingfan-video/core";
import { WebAudioOutput } from "@lingfan-video/infra";
import { makeHarness } from "./support/audio-harness";

const SR = 48_000;
const FPS = 30;
const WIDTH = 64;
const HEIGHT = 36;
const OPTIONS = { fps: FPS, width: WIDTH, height: HEIGHT };

/** 记录型音频输出：只收程序，不发声（render 用） */
class RecordingOutput implements AudioOutput {
  program: AudioProgram | null = null;

  begin(program: AudioProgram): Promise<void> {
    // 深拷贝：render 随后还会往同一份 voices 数组里追加运行期发射的声音
    this.program = structuredClone(program);
    return Promise.resolve();
  }

  start(): LiveVoice {
    return {
      stop: () => undefined,
      setGain: () => undefined,
      setRate: () => undefined,
    };
  }

  dispose(): void {}
}

/** 只收帧、不写文件的导出器：本测试不关心像素，只关心 render 交给音频的程序 */
class DropExporter implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  frames = 0;

  async writeFrame(): Promise<void> {
    this.frames += 1;
  }

  async finalize(): Promise<ExportResult> {
    return { output: "", frames: this.frames, durationMs: 0, format: "frames" };
  }
}

/** 逐项可比的声部轮廓（clip 取 url、合成取参数，两者互斥） */
function outline(voice: AudioVoice) {
  return {
    id: voice.id,
    startMs: voice.startMs,
    clip: voice.clip.url,
    gain: voice.gain,
    bus: voice.bus ?? null,
    synth: voice.synth ?? null,
  };
}

/** 覆盖登记期配乐的主要形态：总线/发送/自动化、bgm 循环、素材声、程序化声 */
function makeScene(): Scene<unknown> {
  return createScene(1200, (_prev, env) => {
    env.bus({ id: "music", gain: 0.6 });
    env.bus({ id: "hall", gain: 0.35 });
    env.send({ from: "music", to: "hall", amount: 0.25 });
    env.automate({
      bus: "music",
      points: [{ atMs: 400, gain: 0.8, rampMs: 200 }],
    });
    env.bgm(clip("pad"), { gain: gain(0.4), bus: "music" });
    env.synth({
      wave: "sine",
      freq: 220,
      durationMs: 600,
      gain: 0.3,
      bus: "music",
    });
    env.step(600, () => {});
    env.synth({
      wave: "triangle",
      freq: 660,
      durationMs: 240,
      pan: 0.4,
      bus: "hall",
    });
    env.audio(clip("blip"), {
      at: 80,
      gain: gain(0.5, { fadeOut: 100 }),
      bus: "hall",
    });
    env.step(600, () => {});
  });
}

describe("编译音频程序：不渲染帧也拿到同一份程序", () => {
  it("与 render 交给 audioOutput 的程序逐项相等", async () => {
    const scene = makeScene();
    const compiled = await compileAudioProgram(scene, OPTIONS);

    const output = new RecordingOutput();
    const exporter = new DropExporter();
    await render(scene, {
      ...OPTIONS,
      exporter,
      audioOutput: output,
      headless: true,
      frames: "allow-blank",
    });
    const recorded = output.program;
    expect(recorded).not.toBeNull();
    if (recorded === null) throw new Error("render 没有把程序交给音频输出");

    expect(compiled.voices.length).toBeGreaterThan(1);
    expect(recorded.voices.length).toBe(compiled.voices.length);
    expect(recorded.durationMs).toBe(compiled.durationMs);
    expect(recorded.voices.map(outline)).toEqual(compiled.voices.map(outline));
    expect(recorded.voices).toEqual(compiled.voices);
    expect(recorded.graph).toEqual(compiled.graph);
  });

  it("同一场景重复编译结果完全相等（确定性）", async () => {
    const scene = makeScene();
    const first = await compileAudioProgram(scene, OPTIONS);
    const second = await compileAudioProgram(scene, OPTIONS);
    expect(second).toEqual(first);
  });
});

/** 程序化声部（不加载素材） */
function synthVoice(id: string, freq: number): AudioVoice {
  return {
    id,
    clip: clip(`synth:${id}`),
    startMs: 0,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    synth: { wave: "sine", freq, durationMs: 120, gain: 0.4 },
  };
}

/** 素材声部（走加载器） */
function clipVoice(id: string, url: string, startMs: Ms): AudioVoice {
  return {
    id,
    clip: clip(url),
    startMs,
    gain: { value: 0.5 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
  };
}

/** 合成器替身：预热的素材路径只要求 AudioBuffer 的最小面 */
function fakeBuffer(frames: number): AudioBuffer {
  const data = new Float32Array(frames).fill(0.25);
  return {
    length: frames,
    sampleRate: SR,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

describe("warm：预热只填缓存", () => {
  it("不需要 AudioWorklet、不移动时间线，重复调用不重复加载素材", async () => {
    const harness = makeHarness();
    let loads = 0;
    const output = new WebAudioOutput(
      harness.ctx as unknown as AudioContext,
      async (): Promise<AudioBuffer> => {
        loads += 1;
        return fakeBuffer(480);
      },
    );
    const before = output.nowMs();
    const program: AudioProgram = {
      durationMs: 400,
      voices: [synthVoice("a", 440), clipVoice("b", "pad", 120)],
    };

    // 环境里没有 AudioWorkletNode：warm 若去建节点会直接抛错
    await output.warm(program);
    await output.warm(program);

    expect(loads).toBe(1);
    expect(output.nowMs()).toBe(before);
  });
});
