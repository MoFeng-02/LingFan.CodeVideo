/**
 * WebAudio 实时预览播放适配器：按引擎收集的音频事件表预排播放。
 * 与导出端离线混音同源事件（样本=时间线纯函数），预览延迟由上下文时钟对齐。
 * 仅浏览器环境可用（AudioContext 为平台 API）；Node 下不要装配。
 */
import type { AudioTimelineEvent, Ms } from "@lingfan-video/contracts";

/** 资源加载：把 clip url 变成 AudioBuffer（宿主注入，通常 fetch + decodeAudioData） */
export type AudioBufferLoader = (url: string) => Promise<AudioBuffer>;

/** 预排提前量（秒）：给加载与调度留余量，避免起点被吞 */
const SCHEDULE_LEAD_SEC = 0.06;

export class WebAudioPlayer {
  private readonly sources: AudioBufferSourceNode[] = [];
  private startedAtSec = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly load: AudioBufferLoader,
  ) {}

  /**
   * 预排整条时间线：事件表 → 各事件的 source/gain/pan 节点，统一从上下文当前时刻起排。
   * 事件时长：loop = 到时间线尾；否则 = 源缓冲自然长度。
   */
  async play(
    events: readonly AudioTimelineEvent[],
    durationMs: Ms,
  ): Promise<void> {
    const t0 = this.ctx.currentTime + SCHEDULE_LEAD_SEC;
    this.startedAtSec = t0;
    for (const ev of events) {
      const buffer = await this.load(ev.clipUrl);
      const start = t0 + ev.globalAtMs / 1000;
      // 已过起点的事件不再补播（预览从时间线头部开始）
      if (start < this.ctx.currentTime) continue;
      const remainingMs = durationMs - ev.globalAtMs;
      const durSec = Math.max(
        0,
        ev.loop
          ? remainingMs / 1000
          : Math.min(buffer.duration, remainingMs / 1000),
      );
      if (durSec <= 0) continue;
      this.scheduleEvent(ev, buffer, start, durSec);
    }
  }

  /** 立即停止全部已排节点（预览重跑/切幕用） */
  stop(): void {
    for (const s of this.sources.splice(0)) {
      try {
        s.stop();
      } catch {
        // 未开始的节点 stop 抛 InvalidStateError，忽略
      }
    }
  }

  /** 单事件节点图：source → [gain 包络] → [pan] → destination */
  private scheduleEvent(
    ev: AudioTimelineEvent,
    buffer: AudioBuffer,
    start: number,
    durSec: number,
  ): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = ev.loop;
    if (ev.channels !== undefined) {
      // 目标声道数（缺省跟随源；显式 = 强制该布局）
      src.channelCount = Math.max(1, ev.channels);
      src.channelCountMode = "explicit";
    }
    const gain = this.ctx.createGain();
    this.applyGainEnvelope(gain, ev, start, durSec);
    let tail: AudioNode = gain;
    if (ev.pan !== 0) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, ev.pan));
      gain.connect(panner);
      tail = panner;
    }
    src.connect(gain);
    tail.connect(this.ctx.destination);
    src.start(start);
    this.sources.push(src);
  }

  /** 音量与淡入淡出：以事件起点/终点为锚的线性包络 */
  private applyGainEnvelope(
    gain: GainNode,
    ev: AudioTimelineEvent,
    start: number,
    durSec: number,
  ): void {
    const end = start + durSec;
    const g = gain.gain;
    const fadeIn = Math.min((ev.fadeIn ?? 0) / 1000, durSec);
    const fadeOut = Math.min((ev.fadeOut ?? 0) / 1000, durSec);
    if (fadeIn > 0) {
      g.setValueAtTime(0, start);
      g.linearRampToValueAtTime(ev.volume, start + fadeIn);
    } else {
      g.setValueAtTime(ev.volume, start);
    }
    if (fadeOut > 0) {
      g.setValueAtTime(ev.volume, end - fadeOut);
      g.linearRampToValueAtTime(0, end);
    }
    // 事件自然结束（非 loop）在终点收声
    if (!ev.loop) g.setValueAtTime(0, end);
  }
}
