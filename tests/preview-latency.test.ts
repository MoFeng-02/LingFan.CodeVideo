/**
 * 预览时钟的设备延迟补偿：音频上下文里排下的样本要过 baseLatency + outputLatency
 * 才真正出声，画面若按 ctx.currentTime 走就会早于听到的声音。
 * 这里验证：补偿量 = 两段延迟之和、有上限钳制、未知延迟按 0 处理。
 */
import { describe, expect, it } from "vitest";
import { WebAudioOutput } from "@lingfan-video/infra";
import { flush } from "./support/audio-harness";
import { installWorklet } from "./support/worklet-harness";

const START_SEC = 10;
const ADVANCE_MS = 500;

interface CtxClock {
  currentTime: number;
  baseLatency: number;
  outputLatency: number;
}

/** 用替身上下文跑一遍 begin，再把时钟推进到「起点后 500ms」 */
async function outputAt(latency: {
  baseLatency?: number;
  outputLatency?: number;
}): Promise<{ nowMs: number }> {
  const capture = installWorklet();
  try {
    const clock = capture.harness.ctx as unknown as Partial<CtxClock>;
    if (latency.baseLatency === undefined) delete clock.baseLatency;
    else clock.baseLatency = latency.baseLatency;
    if (latency.outputLatency === undefined) delete clock.outputLatency;
    else clock.outputLatency = latency.outputLatency;
    const out = new WebAudioOutput(
      capture.harness.ctx as unknown as AudioContext,
      () => Promise.reject(new Error("测试不加载素材")),
    );
    await out.begin({ durationMs: 1000, voices: [] });
    clock.currentTime = START_SEC + ADVANCE_MS / 1000;
    await flush();
    return { nowMs: out.nowMs() };
  } finally {
    capture.restore();
  }
}

describe("预览时钟的延迟补偿", () => {
  it("不报延迟的上下文不补偿：时钟 = 上下文时间 - 起点", async () => {
    const { nowMs } = await outputAt({ baseLatency: 0, outputLatency: 0 });
    expect(nowMs).toBeCloseTo(ADVANCE_MS, 6);
  });

  it("补偿量等于 baseLatency + outputLatency（秒换算成毫秒）", async () => {
    const { nowMs } = await outputAt({
      baseLatency: 0.005,
      outputLatency: 0.015,
    });
    expect(nowMs).toBeCloseTo(ADVANCE_MS - 20, 6);
  });

  it("异常大的设备延迟被钳到上限（不让画面倒退太多）", async () => {
    const { nowMs } = await outputAt({ baseLatency: 0.2, outputLatency: 0.2 });
    expect(nowMs).toBeCloseTo(ADVANCE_MS - 250, 6);
  });

  it("缺字段的平台按 0 处理", async () => {
    const { nowMs } = await outputAt({});
    expect(nowMs).toBeCloseTo(ADVANCE_MS, 6);
  });
});
