/**
 * PacedPreviewExporter：预览排帧的主时钟纪律。
 * 关键回归：画面必须跟「视频/音频共用的主时钟」推进——首次创建 AudioContext 时其时钟可能
 * 冷启动数秒，若画面跟墙钟就会出现「视频放完了声音还在放」。
 */
import { describe, expect, it } from "vitest";
import { PacedPreviewExporter } from "../packages/infra/src/preview/paced-exporter";
import type { FrameBitmap, Ms } from "@lingfan-video/contracts";

const frame: FrameBitmap = {
  data: new Uint8ClampedArray(4),
  width: 1,
  height: 1,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("PacedPreviewExporter", () => {
  it("按外部主时钟推进：帧时间戳即真实经过时间", async () => {
    const t0 = performance.now();
    const clock = (): Ms => performance.now() - t0;
    const sink = new PacedPreviewExporter({ clock });
    await sink.writeFrame(frame, 0);
    const before = performance.now();
    await sink.writeFrame(frame, 80);
    const elapsed = performance.now() - before;
    expect(elapsed).toBeGreaterThanOrEqual(60); // 等到时钟走到 80ms 附近（允许调度粒度）
    expect(elapsed).toBeLessThan(400);
  });

  it("主时钟停滞时退回墙钟：预览不会永久卡死", async () => {
    let frozen: Ms = 0;
    const sink = new PacedPreviewExporter({
      clock: () => frozen,
      stallFallbackMs: 40,
    });
    await sink.writeFrame(frame, 0);
    const before = performance.now();
    await sink.writeFrame(frame, 5000); // 时钟不走：应判定失效并放行
    expect(performance.now() - before).toBeLessThan(600);
    frozen = 0; // 保持只读语义，避免 lint 报未使用
  });

  it("finalize 返回帧数与末帧时间戳；reset 复位", async () => {
    const clock = (): Ms => 0;
    const sink = new PacedPreviewExporter({ clock, stallFallbackMs: 10 });
    await sink.writeFrame(frame, 0);
    await sink.writeFrame(frame, 100);
    const out = await sink.finalize();
    expect(out.frames).toBe(2);
    expect(out.durationMs).toBe(100);
    expect(out.format).toBe("frames");
    sink.reset();
    const again = await sink.finalize();
    expect(again.frames).toBe(0);
    await sleep(0);
  });
});
