/**
 * 运行期 `ctx.audio(clip, { at })` 的 at = 相对发射时刻的延迟；
 * 登记期 `env.audio(..., { at })` 仍是相对登记位置。两者不能混用同一套语义。
 */
import { describe, expect, it } from "vitest";
import { TimelineEngine, clip, start } from "@lingfan-video/core";
import type { AudioVoice, Ms, Scene } from "@lingfan-video/contracts";

async function voicesOf(
  scene: Scene<unknown>,
  fps = 20,
): Promise<AudioVoice[]> {
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
  const summary = await engine.run(scene, {
    writeFrame: () => {},
    finalize: async () => {},
  });
  return [...summary.audioVoices];
}

describe("ctx.audio 运行期延迟发射", () => {
  it("at 相对发射时刻：t=100 发射 + at 200 → 起播 300", async () => {
    const main = start(400, (env) => {
      env.step(400, (ctx) => {
        if (ctx.frameIndex === 2) ctx.audio(clip("late"), { at: 200 });
      });
    });

    const voices = await voicesOf(main);
    expect(voices).toHaveLength(1);
    expect(voices[0]!.startMs).toBe(300);
    expect(voices[0]!.clip.url).toBe("late");
  });

  it("登记期 at 仍相对登记位置（两种语义并存）", async () => {
    const main = start(400, (env) => {
      env.audio(clip("early"), { at: 100 }); // 登记于 0 → 起播 100
      env.step(400, (ctx) => {
        if (ctx.frameIndex === 2) ctx.audio(clip("late"), { at: 200 }); // 100+200
      });
    });

    const voices = await voicesOf(main);
    const byClip = new Map(voices.map((v) => [v.clip.url, v.startMs]));
    expect(byClip.get("early")).toBe(100);
    expect(byClip.get("late")).toBe(300);
  });

  it("负 at 按 0 钳（不落到时间线之前）", async () => {
    const main = start(400, (env) => {
      env.step(400, (ctx) => {
        if (ctx.frameIndex === 0) ctx.audio(clip("neg"), { at: -100 });
      });
    });

    const voices = await voicesOf(main);
    expect(voices).toHaveLength(1);
    expect(voices[0]!.startMs).toBe(0);
  });
});
