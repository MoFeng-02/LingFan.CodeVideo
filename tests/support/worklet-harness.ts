/**
 * 预览端替身：装一个假的 AudioWorkletNode，把适配器发给音频线程的消息记下来，
 * 再用同一个内核把这些消息渲染成 PCM——于是「预览听到什么」可以被逐样本检查。
 */
import type { AudioProgram } from "@lingfan-video/contracts";
import { StreamingMixer } from "../../packages/infra/src/audio/dsp";
import { WebAudioOutput } from "../../packages/infra/src/audio/web-audio-player";
import type { MixerMessage } from "../../packages/infra/src/audio/worklet/protocol";
import { makeHarness, type Harness } from "./audio-harness";

/** 一条被截获的消息（transfer 原样保留，便于断言缓冲确实被转移） */
export interface Captured {
  readonly message: MixerMessage;
  readonly transfer?: readonly Transferable[];
}

export interface WorkletCapture {
  readonly harness: Harness;
  readonly messages: Captured[];
  restore(): void;
}

/** 安装假 AudioWorkletNode；调用方负责 restore() */
export function installWorklet(): WorkletCapture {
  const messages: Captured[] = [];
  const scope = globalThis as { AudioWorkletNode?: unknown };
  const previous = scope.AudioWorkletNode;
  const harness = makeHarness();
  const ctx = harness.ctx as unknown as { currentTime: number };
  (
    harness.ctx as unknown as {
      audioWorklet?: { addModule(url: string): Promise<void> };
    }
  ).audioWorklet = { addModule: async () => undefined };
  scope.AudioWorkletNode = class FakeWorkletNode {
    readonly port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: MixerMessage, transfer?: Transferable[]) => {
        messages.push({ message, transfer });
      },
    };
    constructor(..._args: unknown[]) {}
    connect(): void {
      queueMicrotask(() =>
        this.port.onmessage?.({
          data: { type: "started", atSec: ctx.currentTime },
        }),
      );
    }
    disconnect(): void {}
  };
  return {
    harness,
    messages,
    restore: () => {
      scope.AudioWorkletNode = previous;
    },
  };
}

/** 渲染选项：与导出端保持同样的采样率、声道与块尺寸才谈得上逐样本比较 */
export interface PreviewRenderOptions {
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly blockFrames?: number;
}

/** 把截获的消息装回内核并整段渲染（预览端路径的可测替身） */
export function renderMessages(
  messages: readonly Captured[],
  options: PreviewRenderOptions & { readonly durationMs: number },
): Float32Array {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 2;
  const blockFrames = options.blockFrames ?? 128;
  let mixer: StreamingMixer | null = null;
  for (const captured of messages) {
    const message = captured.message;
    if (message.type === "init") {
      mixer = new StreamingMixer({
        sampleRate: message.sampleRate,
        channels: message.channels,
        durationMs: message.durationMs,
        graph: message.graph,
        blockFrames,
      });
      continue;
    }
    if (mixer === null) continue;
    if (message.type === "voice") {
      mixer.addVoice({ voice: message.voice, pcm: message.pcm });
    } else if (message.type === "bus") {
      mixer.setBusParams(
        message.update.id,
        message.update,
        message.atMs,
        message.update.rampMs ?? 0,
      );
    } else if (message.type === "gain") {
      mixer.setVoiceGain(
        message.voiceId,
        message.atMs,
        message.value,
        message.rampMs,
      );
    } else if (message.type === "rate") {
      mixer.setVoiceRate(message.voiceId, message.atMs, message.value);
    } else if (message.type === "stop") {
      mixer.stopVoice(message.voiceId, message.atMs, message.fadeMs);
    }
  }
  if (mixer === null) throw new Error("预览端没有发出 init 消息");
  const frames = Math.ceil((options.durationMs / 1000) * sampleRate);
  const out = new Float32Array(frames * channels);
  for (let start = 0; start < frames; start += blockFrames) {
    const n = Math.min(blockFrames, frames - start);
    mixer.renderBlock(
      start,
      n,
      out.subarray(start * channels, (start + n) * channels),
    );
  }
  return out;
}

/** 预览端整段渲染：begin 一条程序，取回消息，按块渲染 */
export async function previewSamples(
  program: AudioProgram,
  options: PreviewRenderOptions = {},
): Promise<Float32Array> {
  const capture = installWorklet();
  try {
    const output = new WebAudioOutput(
      capture.harness.ctx as unknown as AudioContext,
      async () => {
        throw new Error("测试里只放程序化音源");
      },
    );
    await output.begin(program);
    return renderMessages(capture.messages, {
      durationMs: program.durationMs,
      ...options,
    });
  } finally {
    capture.restore();
  }
}
