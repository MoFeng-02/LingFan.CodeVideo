/**
 * warp 与引擎/校验的衔接：audio 选项的 rate 原样透传进声音记录，
 * 以及校验期兜底拦截绕过组合子的字面量非法选项。
 */
import { describe, expect, it } from "vitest";
import {
  TimelineEngine,
  clip,
  createScene,
  validateScene,
  warp as warpOf,
} from "@lingfan-video/core";
import { MemoryFrameSink } from "@lingfan-video/infra";
import type { AudioRate } from "@lingfan-video/contracts";

describe("warp 与引擎/校验的衔接", () => {
  const engine = () => {
    const e = new TimelineEngine({
      fps: 30,
      width: 4,
      height: 4,
      canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
      headless: true,
    });
    e.setPainter(() => ({
      data: new Uint8ClampedArray(4 * 4 * 4),
      width: 4,
      height: 4,
    }));
    return e;
  };

  it("audio 选项的 rate 透传进声音记录（原样保留，不预解析）", async () => {
    const head = createScene(200, (_prev, env) => {
      env.audio(clip("sfx"), { at: 50, rate: warpOf([0, 0], [100, 200]) });
      env.step(200, () => {});
    });
    const summary = await engine().run(head, new MemoryFrameSink());
    const v = summary.audioVoices[0]!;
    expect(v.rate).toEqual({
      kind: "warp",
      points: [
        { atMs: 0, srcMs: 0 },
        { atMs: 100, srcMs: 200 },
      ],
    });
    expect(v.startMs).toBe(50);
  });

  it("校验期兜底拦截字面量非法选项（组合子之外的结构对象）", () => {
    const badRate = (points: readonly unknown[]): AudioRate =>
      ({ kind: "warp", points }) as AudioRate;
    const scene = createScene(200, (_prev, env) => {
      env.audio(clip("bad"), {
        rate: badRate([
          { atMs: 100, srcMs: 0 },
          { atMs: 100, srcMs: 50 },
        ]),
      });
      env.audio(clip("bad2"), {
        rate: badRate([
          { atMs: 0, srcMs: 100 },
          { atMs: 100, srcMs: 50 },
        ]),
      });
      env.audio(clip("bad3"), { pan: { value: 3 } });
      env.audio(clip("bad4"), { gain: { value: -1 } });
      env.step(200, () => {});
    });
    const errors = validateScene(scene);
    expect(errors.filter((e) => e.code === "spec_violation")).toHaveLength(4);
  });
});
