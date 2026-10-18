/// <reference path="./globals.d.ts" />
/**
 * 预览端音频线程：把单一混音内核放进 AudioWorklet。
 *
 * 主线程负责解码与消息投递，这里只做块处理——与导出端 `mixProgram` 跑的是同一个类，
 * 因此预览听到的样本与导出的样本同源（差异只剩设备延迟与调度抖动）。
 * 处理器不碰任何 WebAudio 节点：输入只有消息，输出只有 renderBlock 写出的交错样本。
 */
import { StreamingMixer } from "../dsp";
import { MIXER_PROCESSOR, type MixerAck, type MixerMessage } from "./protocol";

class PreviewMixerProcessor extends AudioWorkletProcessor {
  private mixer: StreamingMixer | null = null;
  private channels = 2;
  private blockFrames = 128;
  private totalFrames = 0;
  private frame = 0;
  private announced = false;
  private scratch = new Float32Array(0);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<MixerMessage>) => {
      try {
        this.handle(event.data);
      } catch (error) {
        this.ack({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  override process(
    _inputs: readonly Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    for (const channel of out) channel.fill(0);
    if (this.mixer === null) return true;
    if (!this.announced) {
      this.announced = true;
      this.ack({ type: "started", atSec: currentTime });
    }
    if (this.frame >= this.totalFrames) return false;
    const frames = out[0]!.length;
    const span = Math.min(frames, this.totalFrames - this.frame);
    const channels = Math.min(out.length, this.channels);
    const need = span * this.channels;
    if (this.scratch.length < need) this.scratch = new Float32Array(need);
    const buf = this.scratch.subarray(0, need);
    this.mixer.renderBlock(this.frame, span, buf);
    for (let i = 0; i < span; i++) {
      for (let ch = 0; ch < channels; ch++)
        out[ch]![i] = buf[i * this.channels + ch]!;
    }
    this.frame += span;
    return true;
  }

  private handle(msg: MixerMessage): void {
    if (msg.type === "init") {
      this.channels = Math.max(1, msg.channels);
      this.totalFrames = Math.ceil((msg.durationMs / 1000) * msg.sampleRate);
      this.frame = 0;
      this.announced = false;
      this.mixer = new StreamingMixer({
        sampleRate: msg.sampleRate,
        channels: this.channels,
        durationMs: msg.durationMs,
        graph: msg.graph,
        blockFrames: this.blockFrames,
      });
      return;
    }
    if (this.mixer === null) return;
    if (msg.type === "voice") {
      this.mixer.addVoice({ voice: msg.voice, pcm: msg.pcm });
      return;
    }
    if (msg.type === "bus") {
      this.mixer.setBusParams(
        msg.update.id,
        {
          gain: msg.update.gain,
          pan: msg.update.pan,
          mute: msg.update.mute,
          solo: msg.update.solo,
        },
        msg.atMs,
        msg.update.rampMs ?? 0,
      );
      return;
    }
    if (msg.type === "gain") {
      this.mixer.setVoiceGain(msg.voiceId, msg.atMs, msg.value, msg.rampMs);
      return;
    }
    if (msg.type === "rate") {
      this.mixer.setVoiceRate(msg.voiceId, msg.atMs, msg.value);
      return;
    }
    this.mixer.stopVoice(msg.voiceId, msg.atMs, msg.fadeMs);
  }

  private ack(message: MixerAck): void {
    this.port.postMessage(message);
  }
}

registerProcessor(MIXER_PROCESSOR, PreviewMixerProcessor);
