/**
 * 预览端实时播放的生命周期：事件寿命与总时间线终界。
 * 关注点不是听感而是「什么时候停」——源节点必须显式 stop，loop 源尤其：
 * 它本身无限长，不排终止点就会在视频跑完后一直响。
 */
import { describe, expect, it } from "vitest";
import type { AudioTimelineEvent } from "@lingfan-video/contracts";
import { WebAudioPlayer } from "@lingfan-video/infra";

const START_CTX_SEC = 10;
/** 与实现一致的预排提前量（秒） */
const LEAD_SEC = 0.06;
const T0 = START_CTX_SEC + LEAD_SEC;

interface SourceRec {
  loop: boolean;
  startAt?: number;
  offset?: number;
  stopAt?: number;
  stopCalled?: boolean;
  rates: { value: number; at: number }[];
}

interface GainEvent {
  value: number;
  at: number;
  ramp: boolean;
}

/** 最小 AudioContext 替身：记录 source 的 start/stop 与 gain 包络调用即可断言 */
function makeHarness() {
  const sources: SourceRec[] = [];
  const gains: GainEvent[] = [];
  const ctx = {
    currentTime: START_CTX_SEC,
    destination: {},
    createBufferSource() {
      const rec: SourceRec = { loop: false, rates: [] };
      sources.push(rec);
      return {
        buffer: null as AudioBuffer | null,
        get loop() {
          return rec.loop;
        },
        set loop(v: boolean) {
          rec.loop = v;
        },
        channelCount: 1,
        channelCountMode: "max",
        playbackRate: {
          setValueAtTime(value: number, at: number) {
            rec.rates.push({ value, at });
          },
        },
        connect() {},
        start(at: number, offset = 0) {
          rec.startAt = at;
          rec.offset = offset;
        },
        stop(at?: number) {
          rec.stopAt = at;
          rec.stopCalled = true;
        },
      };
    },
    createGain() {
      return {
        gain: {
          setValueAtTime(value: number, at: number) {
            gains.push({ value, at, ramp: false });
          },
          linearRampToValueAtTime(value: number, at: number) {
            gains.push({ value, at, ramp: true });
          },
        },
        connect() {},
      };
    },
    createStereoPanner() {
      return { pan: { value: 0 }, connect() {} };
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources, gains };
}

function event(over: Partial<AudioTimelineEvent>): AudioTimelineEvent {
  return {
    clipUrl: "clip",
    globalAtMs: 0,
    volume: 1,
    loop: false,
    pan: 0,
    ...over,
  };
}

async function playOne(
  ev: AudioTimelineEvent,
  durationMs: number,
  clipSec = 2,
) {
  const h = makeHarness();
  const player = new WebAudioPlayer(
    h.ctx,
    async () => ({ duration: clipSec }) as AudioBuffer,
  );
  await player.play([ev], durationMs);
  return h;
}

describe("预览播放的生命周期", () => {
  it("loop 事件在总时间线尾被显式停止（不会越过视频末尾一直响）", async () => {
    const { sources, gains } = await playOne(event({ loop: true }), 3000);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.loop).toBe(true);
    // 起播 = t0，终止 = t0 + 剩余时长（此处 3000ms）
    expect(sources[0]!.startAt).toBeCloseTo(T0, 4);
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 3, 4);
    // 终点收声同样覆盖 loop（否则停止前的硬切会留一声爆音）
    expect(
      gains.some((g) => g.value === 0 && Math.abs(g.at - (T0 + 3)) < 1e-4),
    ).toBe(true);
  });

  it("非 loop 短源：播完即停", async () => {
    const { sources } = await playOne(event({}), 3000, 0.5);
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 0.5, 4);
  });

  it("非 loop 长源：裁到时间线尾，不越界", async () => {
    const { sources } = await playOne(event({ globalAtMs: 2000 }), 3000, 6);
    expect(sources[0]!.startAt).toBeCloseTo(T0 + 2, 4);
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 3, 4);
  });

  it("起点已在时间线尾之后：不排事件", async () => {
    const { sources } = await playOne(event({ globalAtMs: 3000 }), 3000);
    expect(sources).toHaveLength(0);
  });

  it('收尾映射（srcMs: "end"）：终止点跟随压缩后的自然时长', async () => {
    const { sources } = await playOne(
      event({
        warp: [
          { atMs: 0, srcMs: 0 },
          { atMs: 400, srcMs: "end" },
        ],
      }),
      1000,
      1,
    );
    // 1s 源压进 400ms = 2.5 倍速
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 0.4, 4);
    expect(sources[0]!.rates[0]!.value).toBeCloseTo(2.5, 6);
  });

  it("stop() 立即终止全部已排节点（重播/切幕）", async () => {
    const h = makeHarness();
    const player = new WebAudioPlayer(
      h.ctx,
      async () => ({ duration: 2 }) as AudioBuffer,
    );
    await player.play(
      [event({ loop: true }), event({ globalAtMs: 500 })],
      2000,
    );
    expect(h.sources).toHaveLength(2);
    player.stop();
    for (const s of h.sources) expect(s.stopCalled).toBe(true);
  });
});
