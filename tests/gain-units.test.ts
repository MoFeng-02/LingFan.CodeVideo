/**
 * 增益记法（线性幅度 / 分贝）：折算只有一处，所有可写增益的入口共用同一结果。
 * 覆盖四件事：
 * 1. 折算本身（含非法值）
 * 2. 登记期与运行期入口（gain 组合子、句柄 setGain、总线句柄、自动化点）
 * 3. 折算后平台侧只见线性值（双端同源：预览节点与导出样本一致）
 * 4. 静态校验与登记期报错同口径
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, clip, createScene, gain } from "@lingfan-video/core";
import type { RunSummary } from "@lingfan-video/core";
import { MemoryFrameSink, OfflineAudioMixer } from "@lingfan-video/infra";
import type { AudioVoice, SynthSpec } from "@lingfan-video/contracts";
import {
  dbToLinear,
  toLinearGain,
} from "../packages/core/src/domain/audio/gain-units";
import { automationErrors } from "../packages/core/src/domain/audio/automation";

const SR = 48_000;
const MINUS_6_DB = dbToLinear(-6);

function makeEngine() {
  const engine = new TimelineEngine({
    fps: 30,
    width: 4,
    height: 4,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
  });
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(4 * 4 * 4),
    width: 4,
    height: 4,
  }));
  return engine;
}

const runScene = (scene: ReturnType<typeof createScene>): Promise<RunSummary> =>
  makeEngine().run(scene, new MemoryFrameSink());

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("期望抛错，实际没有");
}

const SYNTH: SynthSpec = { wave: "sine", freq: 440, durationMs: 200 };

/** 合成声音（不走素材解码，混音器只吃 renderSynth 的确定性样本） */
function synthVoice(gainValue: AudioVoice["gain"]): AudioVoice {
  return {
    id: "s",
    clip: clip("synth:inline"),
    startMs: 0,
    gain: gainValue,
    pan: { value: 0 },
    loop: null,
    rate: null,
    ops: [],
    synth: SYNTH,
  };
}

function mixer(): OfflineAudioMixer {
  return new OfflineAudioMixer(
    {
      decode() {
        return Promise.reject(new Error("synth 声音不应走素材解码"));
      },
    },
    { sampleRate: SR, channels: 2 },
  );
}

describe("增益记法折算", () => {
  it("线性幅度原样返回，分贝按 20·log10 折算", () => {
    expect(toLinearGain(0.5, "g")).toBe(0.5);
    expect(toLinearGain({ db: 0 }, "g")).toBe(1);
    expect(toLinearGain({ db: -6 }, "g")).toBeCloseTo(0.501187, 6);
    expect(toLinearGain({ db: 6 }, "g")).toBeCloseTo(1.995262, 6);
    expect(toLinearGain({ db: -60 }, "g")).toBeCloseTo(0.001, 9);
  });

  it("非法记法在折算处报 spec_violation", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = errorOf(() => toLinearGain(bad, "g"));
      expect(err.name).toBe("SpecViolation");
      expect(err.message).toContain("g=");
    }
    for (const bad of [
      { db: Number.NaN },
      { db: Number.POSITIVE_INFINITY },
      { db: "0" as unknown as number },
    ]) {
      const err = errorOf(() => toLinearGain(bad, "g"));
      expect(err.name).toBe("SpecViolation");
      expect(err.message).toContain("db=");
    }
  });

  it("gain 组合子产出线性幅度并保留 fade 校验", () => {
    expect(gain({ db: -6 }).value).toBeCloseTo(MINUS_6_DB, 9);
    expect(gain(0.25, { fadeIn: 100 }).value).toBe(0.25);
    expect(errorOf(() => gain({ db: -6 }, { fadeIn: -1 })).name).toBe(
      "SpecViolation",
    );
  });
});

describe("可写增益入口", () => {
  it("登记期声音的 dB 增益落成线性幅度", async () => {
    const scene = createScene(100, (_prev, env) => {
      env.audio(clip("pad"), { gain: gain({ db: -6 }) });
      env.step(100, () => {});
    });
    const summary = await runScene(scene);
    expect(summary.audioVoices[0]!.gain.value).toBeCloseTo(MINUS_6_DB, 9);
  });

  it("运行期 setGain 的 dB 写进操作记录时已是线性值", async () => {
    const scene = createScene(100, (_prev, env) => {
      env.step(100, (ctx) => {
        const h = ctx.audio(clip("pad"));
        h?.setGain({ db: -6 });
      });
    });
    const summary = await runScene(scene);
    const op = summary.audioVoices[0]!.ops.find((o) => o.kind === "gain");
    expect(op?.kind === "gain" ? op.value : undefined).toBeCloseTo(
      MINUS_6_DB,
      9,
    );
  });

  it("声明式自动化点的 dB 落成线性轨迹", async () => {
    const scene = createScene(200, (_prev, env) => {
      env.bus({ id: "music" });
      env.automate({
        bus: "music",
        points: [{ atMs: 0, gain: { db: -6 } }],
      });
      env.step(200, () => {});
    });
    const summary = await runScene(scene);
    const track = summary.audioGraph.automation.find((a) => a.bus === "music");
    expect(track).toBeDefined();
    const gains = track!.points.map((p) => p.gain);
    expect(gains[0]).toBeCloseTo(MINUS_6_DB, 6);
    // 轨迹上只留线性幅度，不留 { db } 对象
    for (const g of gains) expect(typeof g).toBe("number");
  });

  it("总线句柄的 dB 经逐帧采样落成线性幅度", async () => {
    const scene = createScene(200, (_prev, env) => {
      env.bus({ id: "music" });
      env.step(100, (ctx) => {
        ctx.bus("music").gain({ db: -3 });
      });
      env.step(100, () => {});
    });
    const summary = await runScene(scene);
    const track = summary.audioGraph.automation.find((a) => a.bus === "music");
    expect(track).toBeDefined();
    const gains = track!.points.map((p) => p.gain);
    expect(gains.some((g) => Math.abs(g - dbToLinear(-3)) < 1e-6)).toBe(true);
    for (const g of gains) expect(typeof g).toBe("number");
  });

  it("非法 dB 在登记期即报错（与静态校验同口径）", async () => {
    const problems = automationErrors({
      bus: "music",
      points: [{ atMs: 0, gain: { db: Number.NaN } }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("db=");
    const scene = createScene(100, (_prev, env) => {
      env.automate({
        bus: "music",
        points: [{ atMs: 0, gain: { db: Number.NaN } }],
      });
      env.step(100, () => {});
    });
    await expect(runScene(scene)).rejects.toThrow(/spec_violation/);
  });
});

describe("折算后双端同源", () => {
  it("dB 写法与等值线性写法产出同一份样本", async () => {
    const m = mixer();
    const programOf = (g: AudioVoice["gain"]) => ({
      durationMs: 200,
      voices: [synthVoice(g)],
    });
    const [byDb] = await m.renderProgram(programOf(gain({ db: -6 })));
    const [byLinear] = await m.renderProgram(programOf(gain(MINUS_6_DB)));
    expect(byDb!.data.length).toBe(byLinear!.data.length);
    let maxDiff = 0;
    for (let i = 0; i < byDb!.data.length; i++)
      maxDiff = Math.max(
        maxDiff,
        Math.abs(byDb!.data[i]! - byLinear!.data[i]!),
      );
    expect(maxDiff).toBe(0);
  });

  it("dB 增益确实缩放了导出样本", async () => {
    const m = mixer();
    const [unit] = await m.renderProgram({
      durationMs: 200,
      voices: [synthVoice(gain(1))],
    });
    const [halved] = await m.renderProgram({
      durationMs: 200,
      voices: [synthVoice(gain({ db: -6 }))],
    });
    const peak = (data: Float32Array): number => {
      let p = 0;
      for (const v of data) p = Math.max(p, Math.abs(v));
      return p;
    };
    expect(peak(halved!.data) / peak(unit!.data)).toBeCloseTo(MINUS_6_DB, 4);
  });
});
