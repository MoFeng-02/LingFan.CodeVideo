/**
 * WebAudio 实时预览适配器（AudioOutput 契约的预览端实现）：边跑边发。
 * begin 预加载并预排登记期声音；start 承接运行期 ctx.audio 发射；
 * 时间映射/包络与导出端共用 `evaluateVoice`（同一求值点，预览与导出不漂移）。
 * 仅浏览器环境可用（AudioContext 为平台 API）；Node 下不要装配。
 */
import type {
  AudioOutput,
  AudioProgram,
  AudioVoice,
  LiveVoice,
  Ms,
} from "@lingfan-video/contracts";
import { rateSegments, resolveWarp } from "./warp";
import { evaluateVoice } from "./voice-timeline";

/** 资源加载：把 clip url 变成 AudioBuffer（宿主注入，通常 fetch + decodeAudioData） */
export type AudioBufferLoader = (url: string) => Promise<AudioBuffer>;

/** 预排提前量（秒）：给加载与调度留余量，避免起点被吞 */
const SCHEDULE_LEAD_SEC = 0.06;

export class WebAudioOutput implements AudioOutput {
  private readonly nodes: AudioBufferSourceNode[] = [];
  private readonly loaded = new Map<string, Promise<AudioBuffer>>();
  private startedAtSec = 0;
  private programDurationMs = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly load: AudioBufferLoader,
  ) {}

  /** 锚定时间线起点：预加载并预排登记期声音 */
  async begin(program: AudioProgram): Promise<void> {
    this.dispose();
    this.startedAtSec = this.ctx.currentTime + SCHEDULE_LEAD_SEC;
    this.programDurationMs = program.durationMs;
    await Promise.all(program.voices.map((v) => this.bufferOf(v.clip.url)));
    for (const voice of program.voices) this.schedule(voice);
  }

  /** 运行期发射：即时排程（起点已过则从偏移接上） */
  start(voice: AudioVoice): LiveVoice {
    const live = this.schedule(voice);
    if (live) return live;
    // 缓冲尚未就绪或已过终点：返回空操作句柄，调用语义不报错（预览可丢，导出不丢）
    const noop = (): void => {};
    return { stop: noop, setGain: noop, setRate: noop };
  }

  /** 清场（重播/切幕） */
  dispose(): void {
    for (const n of this.nodes.splice(0)) {
      try {
        n.stop();
      } catch {
        // 未开始的节点 stop 抛 InvalidStateError，忽略
      }
    }
  }

  /** 兼容旧名：等同 dispose */
  stop(): void {
    this.dispose();
  }

  private bufferOf(url: string): Promise<AudioBuffer> {
    const hit = this.loaded.get(url);
    if (hit) return hit;
    const p = this.load(url);
    this.loaded.set(url, p);
    return p;
  }

  /** 全局时间线毫秒 → 上下文秒（已过起点时为负） */
  private ctxSecOf(globalMs: Ms): number {
    return this.startedAtSec + globalMs / 1000;
  }

  /** 单声音节点图：source（含变速自动化）→ gain（包络）→ [pan] → destination */
  private schedule(voice: AudioVoice): LiveVoice | null {
    const pending = this.bufferOf(voice.clip.url);
    let src: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let start = 0;
    let end = 0;
    let tl: ReturnType<typeof evaluateVoice> | null = null;

    pending
      .then((buffer) => {
        tl = evaluateVoice(
          voice,
          buffer.duration * 1000,
          this.programDurationMs,
        );
        if (tl.endMs <= Math.max(tl.startMs, this.nowMs())) return;
        start = this.ctxSecOf(tl.startMs);
        end = this.ctxSecOf(tl.endMs);
        src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = voice.loop !== null;
        this.applyRate(
          src.playbackRate,
          voice,
          tl.startMs,
          buffer.duration * 1000,
        );
        gain = this.ctx.createGain();
        this.applyGain(gain.gain, tl.gainPoints, end);
        let tail: AudioNode = gain;
        if (Math.abs(tl.pan) > 0) {
          const panner = this.ctx.createStereoPanner();
          panner.pan.value = Math.max(-1, Math.min(1, tl.pan));
          gain.connect(panner);
          tail = panner;
        }
        src.connect(gain);
        tail.connect(this.ctx.destination);
        src.start(
          Math.max(start, this.ctx.currentTime),
          Math.max(0, tl.sourceMsAt(tl.startMs) / 1000),
        );
        // 终点显式收声并释放：loop 源本身无限长，不 stop 会越过时间线尾一直响
        src.stop(end);
        this.nodes.push(src);
      })
      .catch(() => {
        // 预览加载失败不打断渲染（导出端由 AudioClock 自己报错）
      });

    const at = (globalMs: Ms): number =>
      Math.max(this.ctxSecOf(globalMs), this.ctx.currentTime);

    return {
      stop: (atMs, fadeMs) => {
        if (!src || !gain) return;
        const stopAt = this.ctxSecOf(atMs);
        const fadeFrom = Math.max(this.ctx.currentTime, stopAt - fadeMs / 1000);
        gain.gain.setValueAtTime(gain.gain.value, fadeFrom);
        gain.gain.linearRampToValueAtTime(0, stopAt);
        try {
          src.stop(stopAt);
        } catch {
          // 已停止
        }
      },
      setGain: (atMs, value, rampMs) => {
        if (!gain) return;
        const t = at(atMs);
        gain.gain.setValueAtTime(gain.gain.value, t);
        if (rampMs > 0)
          gain.gain.linearRampToValueAtTime(value, t + rampMs / 1000);
        else gain.gain.setValueAtTime(value, t);
      },
      setRate: (atMs, value, rampMs) => {
        if (!src) return;
        const t = at(atMs);
        const p = src.playbackRate;
        p.setValueAtTime(p.value, t);
        if (rampMs > 0) p.linearRampToValueAtTime(value, t + rampMs / 1000);
        else p.setValueAtTime(value, t);
      },
    };
  }

  /**
   * 变速自动化：warp 锚点斜率 / 恒速率 → playbackRate 分段（与导出端同一张表）。
   * playbackRate 重采样即磁带式变调，预览与离线混音的音高/时长一致。
   */
  private applyRate(
    param: AudioParam,
    voice: AudioVoice,
    startMs: Ms,
    sourceDurationMs: Ms,
  ): void {
    const start = this.ctxSecOf(startMs);
    const rate = voice.rate;
    if (!rate) return;
    if (rate.kind === "rate") {
      param.setValueAtTime(rate.value, Math.max(start, this.ctx.currentTime));
      return;
    }
    const w = resolveWarp(rate.points, sourceDurationMs);
    const segs = rateSegments(w);
    for (const seg of segs) {
      const t = Math.max(start + seg.fromMs / 1000, this.ctx.currentTime);
      param.setValueAtTime(seg.rate, t);
    }
  }

  /** 增益折线自动化（求值点给出的折点 → AudioParam 线性段），终点归零 */
  private applyGain(
    param: AudioParam,
    points: readonly { atMs: Ms; gain: number }[],
    endSec: number,
  ): void {
    const first = points[0];
    if (!first) return;
    param.setValueAtTime(first.gain, this.ctxSecOf(first.atMs));
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      param.linearRampToValueAtTime(p.gain, this.ctxSecOf(p.atMs));
    }
    param.setValueAtTime(0, endSec);
  }

  private nowMs(): Ms {
    return (this.ctx.currentTime - this.startedAtSec) * 1000;
  }
}
