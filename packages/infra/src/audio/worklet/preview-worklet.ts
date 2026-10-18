/// <reference path="./globals.d.ts" />
/**
 * 预览端音频线程：把单一混音内核放进 AudioWorklet。
 *
 * 主线程负责解码与消息投递，这里只做块处理——与出片端 `mixProgram` 跑的是同一个类，
 * 因此预览听到的样本与出片的样本同源（差异只剩设备延迟与调度抖动）。
 * 处理器不碰任何 WebAudio 节点：输入只有消息，输出只有 renderBlock 写出的交错样本。
 *
 * 线程边界：这里运行在音频线程，只能通过 `port` 收消息（结构化克隆，不能传函数/实例），
 * 也不能访问 DOM 或主线程状态；渲染回调内不得做阻塞式工作（解码在主线程序完成）。
 */
import { StreamingMixer } from "../dsp";
import { MIXER_PROCESSOR, type MixerAck, type MixerMessage } from "./protocol";

/** 预览混音处理器：串起「主线程消息 → 混音内核 → 设备声道缓冲」 */
class PreviewMixerProcessor extends AudioWorkletProcessor {
  /** 混音内核（收到 init 之前为 null，此前的块只输出静音） */
  private mixer: StreamingMixer | null = null;
  /** 输出声道数（init 给出，缺省 2） */
  private channels = 2;
  /** 内核的渲染块长（帧；初始化时传给内核） */
  private blockFrames = 128;
  /** 程序总帧数（init 给出，按总时长与采样率换算） */
  private totalFrames = 0;
  /** 已渲染到的起始帧号（帧，逐块推进） */
  private frame = 0;
  /** 是否已发过启动确认（保证只发一次） */
  private announced = false;
  /** 交错临时缓冲（按需扩容，避免每块分配） */
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

  /**
   * 渲染回调：每块调用一次。
   *
   * 先清空输出（未写到的帧保持静音），首次有效渲染时发 `started` 确认；
   * 已渲染满总帧数后返回 false，处理器停止（要再播需重建节点）。
   * 设备声道数少于内核声道数时丢弃多余声道，多于时多出的声道保持静音。
   *
   * @param _inputs 输入声道数据（本节点 numberOfInputs = 0，恒为空）
   * @param outputs 输出声道数据：`outputs[0][channel]`
   * @returns 是否继续接收渲染回调
   */
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
    /** 本块可写的帧数（受设备块长与剩余总帧数限制） */
    const frames = out[0]!.length;
    /** 本块实际渲染的帧数 */
    const span = Math.min(frames, this.totalFrames - this.frame);
    /** 实际写出的声道数 */
    const channels = Math.min(out.length, this.channels);
    /** 交错缓冲所需样本数 */
    const need = span * this.channels;
    if (this.scratch.length < need) this.scratch = new Float32Array(need);
    /** 内核写出的交错块（只读前 need 个样本） */
    const buf = this.scratch.subarray(0, need);
    this.mixer.renderBlock(this.frame, span, buf);
    for (let i = 0; i < span; i++) {
      for (let ch = 0; ch < channels; ch++)
        out[ch]![i] = buf[i * this.channels + ch]!;
    }
    this.frame += span;
    return true;
  }

  /**
   * 处理主线程消息：init 重建内核，其余消息转成内核调用。
   *
   * init 之前的其它消息直接丢弃（内核还没建）；init 会重置帧计数与启动确认。
   *
   * @param msg 协议消息（结构化克隆后的普通对象）
   */
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
      this.mixer.setVoiceRate(msg.voiceId, msg.atMs, msg.value, msg.rampMs);
      return;
    }
    this.mixer.stopVoice(msg.voiceId, msg.atMs, msg.fadeMs);
  }

  /**
   * 向主线程回执。
   *
   * @param message 启动确认或错误（只带可读原因）
   */
  private ack(message: MixerAck): void {
    this.port.postMessage(message);
  }
}

registerProcessor(MIXER_PROCESSOR, PreviewMixerProcessor);
