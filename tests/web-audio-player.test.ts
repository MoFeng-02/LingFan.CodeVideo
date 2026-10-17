/**
 * 预览端实时发声的生命周期：声音寿命与总时间线终界。
 * 关注点不是听感而是「什么时候停」——源节点必须显式 stop，loop 源尤其：
 * 它本身无限长，不排终止点就会在视频跑完后一直响。
 * 时间映射/包络与导出端同源（evaluateVoice），故终止点与导出端一致。
 */
import { describe, expect, it } from "vitest";
import type { AudioProgram, AudioVoice, Ms } from "@lingfan-video/contracts";
import { WebAudioOutput } from "@lingfan-video/infra";

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

interface ParamEvent {
  value: number;
  at: number;
  ramp: boolean;
}

/** 最小 AudioContext 替身：记录 source 的 start/stop 与参数自动化即可断言 */
function makeHarness() {
  const sources: SourceRec[] = [];
  const gains: ParamEvent[] = [];
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
        playbackRate: {
          get value() {
            return rec.rates.length > 0
              ? rec.rates[rec.rates.length - 1]!.value
              : 1;
          },
          setValueAtTime(value: number, at: number) {
            rec.rates.push({ value, at });
          },
          linearRampToValueAtTime(value: number, at: number) {
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
      const rec = { value: 1 };
      return {
        gain: {
          get value() {
            return rec.value;
          },
          setValueAtTime(value: number, at: number) {
            rec.value = value;
            gains.push({ value, at, ramp: false });
          },
          linearRampToValueAtTime(value: number, at: number) {
            rec.value = value;
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

function voice(startMs: Ms, extra?: Partial<AudioVoice>): AudioVoice {
  return {
    id: "v",
    clip: { url: "clip", kind: "audio" } as AudioVoice["clip"],
    startMs,
    gain: { value: 1 },
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    ...extra,
  };
}

function program(durationMs: Ms, voices: readonly AudioVoice[]): AudioProgram {
  return { durationMs, voices };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function playOne(
  v: AudioVoice,
  durationMs: number,
  clipSec = 2,
): Promise<ReturnType<typeof makeHarness>> {
  const h = makeHarness();
  const out = new WebAudioOutput(
    h.ctx,
    async () => ({ duration: clipSec }) as AudioBuffer,
  );
  await out.begin(program(durationMs, [v]));
  await flush();
  return h;
}

describe("预览发声的生命周期", () => {
  it("loop 声音在总时间线尾被显式停止（不会越过视频末尾一直响）", async () => {
    const { sources, gains } = await playOne(voice(0, { loop: {} }), 3000);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.loop).toBe(true);
    expect(sources[0]!.startAt).toBeCloseTo(T0, 4);
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 3, 4);
    // 终点收声同样覆盖 loop（否则停止前的硬切会留一声爆音）
    expect(
      gains.some((g) => g.value === 0 && Math.abs(g.at - (T0 + 3)) < 1e-4),
    ).toBe(true);
  });

  it("非 loop 短源：播完即停", async () => {
    const { sources } = await playOne(voice(0), 3000, 0.5);
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 0.5, 4);
  });

  it("非 loop 长源：裁到时间线尾，不越界", async () => {
    const { sources } = await playOne(voice(2000), 3000, 6);
    expect(sources[0]!.startAt).toBeCloseTo(T0 + 2, 4);
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 3, 4);
  });

  it("起点已在时间线尾之后：不排声音", async () => {
    const { sources } = await playOne(voice(3000), 3000);
    expect(sources).toHaveLength(0);
  });

  it('收尾映射（srcMs: "end"）：终止点跟随压缩后的自然时长', async () => {
    const { sources } = await playOne(
      voice(0, {
        rate: {
          kind: "warp",
          points: [
            { atMs: 0, srcMs: 0 },
            { atMs: 400, srcMs: "end" },
          ],
        },
      }),
      1000,
      1,
    );
    expect(sources[0]!.stopAt).toBeCloseTo(T0 + 0.4, 4);
    expect(sources[0]!.rates[0]!.value).toBeCloseTo(2.5, 6);
  });

  it("dispose() 立即终止全部已排节点（重播/切幕）", async () => {
    const h = makeHarness();
    const out = new WebAudioOutput(
      h.ctx,
      async () => ({ duration: 2 }) as AudioBuffer,
    );
    await out.begin(program(2000, [voice(0, { loop: {} }), voice(500)]));
    await flush();
    expect(h.sources).toHaveLength(2);
    out.dispose();
    for (const s of h.sources) expect(s.stopCalled).toBe(true);
  });

  it("运行期 start：即时排程并可操作（stop 排到节点）", async () => {
    const h = makeHarness();
    const out = new WebAudioOutput(
      h.ctx,
      async () => ({ duration: 2 }) as AudioBuffer,
    );
    await out.begin(program(4000, []));
    const live = out.start(voice(1000, { loop: {} }));
    await flush();
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]!.startAt).toBeCloseTo(T0 + 1, 4);
    live.stop(3000, 100);
    expect(h.sources[0]!.stopCalled).toBe(true);
    live.setGain(1500, 0.5, 100);
    live.setRate(2000, 2, 0);
    out.dispose();
  });
});
