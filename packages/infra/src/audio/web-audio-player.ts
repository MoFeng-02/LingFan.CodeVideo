/**
 * WebAudio 实时预览播放适配器：按引擎收集的音频事件表预排播放。
 * 与导出端离线混音同源事件（样本=时间线纯函数），预览延迟由上下文时钟对齐。
 * 仅浏览器环境可用（AudioContext 为平台 API）；Node 下不要装配。
 */
import type { AudioTimelineEvent, Ms } from "@lingfan-video/contracts";
import { rateSegments, resolveWarp, timelineMsAtSource } from "./warp";

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
   * 事件寿命 = min(源播完所需时间, 到时间线尾的剩余)：
   * - 非 loop：源播完（变速下时长随映射变化）即收声；
   * - loop：铺到时间线尾为止——总时间线是唯一终界，预览与导出同规（导出端同样裁齐到缓冲尽头）。
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
      const sourceMs = buffer.duration * 1000;
      const warp = resolveWarp(ev.warp, sourceMs);
      const naturalMs = timelineMsAtSource(warp, sourceMs);
      const durSec = Math.max(
        0,
        ev.loop
          ? remainingMs / 1000
          : Math.min(naturalMs / 1000, remainingMs / 1000),
      );
      if (durSec <= 0) continue;
      this.scheduleEvent(ev, buffer, start, durSec, warp);
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
    warp: ReturnType<typeof resolveWarp>,
  ): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = ev.loop;
    if (ev.channels !== undefined) {
      // 目标声道数（缺省跟随源；显式 = 强制该布局）
      src.channelCount = Math.max(1, ev.channels);
      src.channelCountMode = "explicit";
    }
    this.applyWarp(src.playbackRate, warp, start);
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
    // 起点偏移：映射首点声明的源位置（无 warp 时恒为 0）
    src.start(start, Math.max(0, warp.points[0]!.srcMs / 1000));
    // 终止点：节点在事件终点收声并释放。loop 源本身无限长，不显式 stop 会越过时间线尾一直响
    src.stop(start + durSec);
    this.sources.push(src);
  }

  /**
   * 变速：分段线性映射 → 逐段 playbackRate 跳变（同一张 warp 表，与导出端同源）。
   * playbackRate 的重采样即磁带式变调——预览侧与离线混音的音高/时长一致。
   */
  private applyWarp(
    rate: AudioParam,
    warp: ReturnType<typeof resolveWarp>,
    start: number,
  ): void {
    const segs = rateSegments(warp);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const at = start + seg.fromMs / 1000;
      if (i === 0) rate.setValueAtTime(seg.rate, Math.max(start, at));
      else rate.setValueAtTime(seg.rate, at);
    }
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
    // 事件终点一律收声（loop 也一样）：总时间线是唯一终界，越过尾部的余响不保留
    g.setValueAtTime(0, end);
  }
}
