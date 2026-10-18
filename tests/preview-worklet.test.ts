/**
 * 预览端处理器本身：它跑在音频线程里，测试里用替身全局把 worklet 环境搭出来，
 * 直接喂消息、按块调用 process，检查输出与离线混音逐样本一致、末帧后退出、
 * 未初始化时保持静音、以及坏消息会回 error 而不是静默吞掉。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioGraph, AudioVoice } from "@lingfan-video/contracts";
import { OfflineAudioMixer } from "@lingfan-video/infra";
import { renderSynth } from "../packages/infra/src/audio/synth";
import type {
  MixerAck,
  MixerMessage,
} from "../packages/infra/src/audio/worklet/protocol";

const SR = 48_000;
const BLOCK = 128;

interface Processor {
  readonly port: {
    onmessage: ((event: { data: MixerMessage }) => void) | null;
  };
  process(
    inputs: readonly Float32Array[][],
    outputs: Float32Array[][],
  ): boolean;
}

interface WorkletEnv {
  create(): Processor;
  readonly acks: MixerAck[];
}

async function loadWorklet(): Promise<WorkletEnv> {
  const acks: MixerAck[] = [];
  let created: (new () => Processor) | null = null;
  class FakeProcessor {
    readonly port = {
      onmessage: null as Processor["port"]["onmessage"],
      postMessage: (message: MixerAck): void => {
        acks.push(message);
      },
    };
  }
  vi.stubGlobal("AudioWorkletProcessor", FakeProcessor);
  vi.stubGlobal("currentTime", 3);
  vi.stubGlobal(
    "registerProcessor",
    (_name: string, ctor: new () => Processor): void => {
      created = ctor;
    },
  );
  vi.resetModules();
  await import("../packages/infra/src/audio/worklet/preview-worklet");
  if (created === null) throw new Error("处理器没有注册");
  const Ctor = created as unknown as new () => Processor;
  return {
    acks,
    create: () => new Ctor(),
  };
}

function voice(partial: Partial<AudioVoice> = {}): AudioVoice {
  return {
    id: "v0",
    clip: { url: "synth:test", kind: "audio" } as AudioVoice["clip"],
    startMs: 0,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    synth: { wave: "sine", freq: 440, durationMs: 200, gain: 0.5 },
    ...partial,
  };
}

const EMPTY_GRAPH: AudioGraph = {
  buses: [],
  sends: [],
  ducks: [],
  automation: [],
};

function initMessage(durationMs: number): MixerMessage {
  return {
    type: "init",
    sampleRate: SR,
    channels: 2,
    durationMs,
    graph: EMPTY_GRAPH,
  };
}

/** 按 128 帧一块往处理器里灌，收集左右声道 */
function runProcessor(
  proc: Processor,
  durationMs: number,
): { left: Float32Array; right: Float32Array; blocks: number } {
  const total = Math.ceil((durationMs / 1000) * SR);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let written = 0;
  let blocks = 0;
  while (written < total) {
    const ln = new Float32Array(BLOCK);
    const rn = new Float32Array(BLOCK);
    const alive = proc.process([], [[ln, rn]]);
    const span = Math.min(BLOCK, total - written);
    left.set(ln.subarray(0, span), written);
    right.set(rn.subarray(0, span), written);
    written += span;
    blocks++;
    if (!alive) break;
  }
  return { left, right, blocks };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("预览处理器：块渲染", () => {
  it("输出与离线混音逐样本一致", async () => {
    const env = await loadWorklet();
    const proc = env.create();
    const spec = {
      wave: "sine",
      freq: 440,
      durationMs: 200,
      gain: 0.5,
    } as const;
    const v = voice({ synth: spec });
    proc.port.onmessage!({ data: initMessage(300) });
    proc.port.onmessage!({
      data: { type: "voice", voice: v, pcm: renderSynth(spec, SR, 2) },
    });
    const { left, right } = runProcessor(proc, 300);

    const mixer = new OfflineAudioMixer(
      {
        async decode() {
          throw new Error("测试里只放程序化音源");
        },
      },
      { sampleRate: SR, channels: 2 },
    );
    const [exported] = await mixer.renderProgram({
      durationMs: 300,
      voices: [v],
    });
    expect(left.length).toBe(exported!.data.length / 2);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      const l = left[i]!;
      const r = right[i]!;
      peak = Math.max(peak, Math.abs(l));
      expect(l).toBe(exported!.data[i * 2]!);
      expect(r).toBe(exported!.data[i * 2 + 1]!);
    }
    expect(peak).toBeGreaterThan(0.1);
  });

  it("首块回 started，末帧返回 false", async () => {
    const env = await loadWorklet();
    const proc = env.create();
    proc.port.onmessage!({ data: initMessage(1) });
    const total = Math.ceil((1 / 1000) * SR);
    let blocks = 0;
    let alive = true;
    while (alive) {
      alive = proc.process(
        [],
        [[new Float32Array(BLOCK), new Float32Array(BLOCK)]],
      );
      blocks++;
    }
    // 渲完整段之后的下一块才返回 false（音频线程据此摘掉节点）
    expect(blocks).toBe(Math.ceil(total / BLOCK) + 1);
    expect(env.acks.filter((a) => a.type === "started")).toHaveLength(1);
  });

  it("未初始化时：输出静音且不报错", async () => {
    const env = await loadWorklet();
    const proc = env.create();
    const ln = new Float32Array(BLOCK).fill(1);
    const rn = new Float32Array(BLOCK).fill(1);
    expect(proc.process([], [[ln, rn]])).toBe(true);
    expect(ln.every((s) => s === 0)).toBe(true);
    expect(rn.every((s) => s === 0)).toBe(true);
    expect(env.acks).toHaveLength(0);
  });

  it("坏消息回 error：不静默吞掉", async () => {
    const env = await loadWorklet();
    const proc = env.create();
    proc.port.onmessage!({ data: initMessage(100) });
    proc.port.onmessage!({
      data: {
        type: "voice",
        voice: voice({
          rate: {
            kind: "rate",
            value: 0,
          },
        }),
        pcm: renderSynth({ wave: "sine", freq: 440, durationMs: 50 }, SR, 2),
      },
    });
    const error = env.acks.find((a) => a.type === "error");
    expect(error).toBeDefined();
    if (error?.type === "error")
      expect(error.message.length).toBeGreaterThan(0);
  });
});
