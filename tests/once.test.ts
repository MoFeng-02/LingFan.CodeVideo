/**
 * `ctx.once(scope, fn)` —— 音频发射永远是事件，本原语只做「同一作用域只发一次」。
 * 去重键必须确定性（作用域 + 单元实例 + 迭代/实例 id），且每次 run 重置。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, clip, start } from "@lingfan-video/core";
import type { AudioVoice, Ms, Scene } from "@lingfan-video/contracts";

async function runScene(
  scene: Scene<unknown>,
  fps = 20,
): Promise<{ frames: Ms[]; voices: AudioVoice[] }> {
  const engine = new TimelineEngine({
    fps,
    width: 1,
    height: 1,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
  });
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(4),
    width: 1,
    height: 1,
  }));
  const frames: Ms[] = [];
  const summary = await engine.run(scene, {
    writeFrame: (_f, _i, t) => {
      frames.push(t);
    },
    finalize: async () => {},
  });
  return { frames, voices: [...summary.audioVoices] };
}

describe("ctx.once：作用域去重", () => {
  it("unit：整个 step 窗口只发一次（默认作用域）", async () => {
    const main = start(400, (env) => {
      env.step(400, (ctx) => {
        ctx.once((c) => c.audio(clip("hit")));
      });
    });
    const { frames, voices } = await runScene(main);
    expect(frames.length).toBe(8);
    expect(voices).toHaveLength(1);
    expect(voices[0]!.clip.url).toBe("hit");
  });

  it("iteration：loop 每轮一次", async () => {
    const main = start(350, (env) => {
      env.loop({
        ms: 100,
        fn: (ctx) => {
          ctx.once("iteration", (c) => c.audio(clip("tick")));
        },
      });
    });
    const { voices } = await runScene(main);
    // 350ms / 100ms → 迭代 0..3（末轮窗口 300..350）
    expect(voices.length).toBe(4);
  });

  it("scene：跨多个单元整场一次", async () => {
    const main = start(400, (env) => {
      env.par([
        (b) =>
          b.step(400, (ctx) => {
            ctx.once("scene", (c) => c.audio(clip("intro")));
          }),
        (b) =>
          b.step(400, (ctx) => {
            ctx.once("scene", (c) => c.audio(clip("intro")));
          }),
      ]);
    });
    const { voices } = await runScene(main);
    expect(voices).toHaveLength(1);
  });

  it("两个单元各自 unit 去重互不影响", async () => {
    const main = start(200, (env) => {
      env.par([
        (b) =>
          b.step(200, (ctx) => {
            ctx.once((c) => c.audio(clip("a")));
          }),
        (b) =>
          b.step(200, (ctx) => {
            ctx.once((c) => c.audio(clip("b")));
          }),
      ]);
    });
    const { voices } = await runScene(main);
    expect(voices.map((v) => v.clip.url).sort()).toEqual(["a", "b"]);
  });

  it("spawn：每个实例一次，forever 重放不重复", async () => {
    const child = start(100, (env) => {
      env.step(100, (ctx) => {
        ctx.once("spawn", (c) => c.audio(clip("roar")));
      });
    });
    const main = start(300, (env) => {
      env.spawn(child, { key: "a", forever: true });
      env.spawn(child, { key: "b", forever: true });
      env.step(300, () => {});
    });
    const { voices } = await runScene(main);
    expect(voices).toHaveLength(2);
  });

  it("重复 run 会重置去重登记（不跨次残留）", async () => {
    const main = start(200, (env) => {
      env.step(200, (ctx) => {
        ctx.once((c) => c.audio(clip("once")));
      });
    });
    const first = await runScene(main);
    const second = await runScene(main);
    expect(first.voices).toHaveLength(1);
    expect(second.voices).toHaveLength(1);
  });
});
