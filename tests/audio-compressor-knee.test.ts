/**
 * 压缩器拐点：缺省是硬拐点（阈值以下完全不压），给出 `kneeDb` 后在阈值附近平滑过渡。
 * 直接驱动 DSP 内核，避免 WebAudio 节点参数差异干扰。
 */
import { describe, expect, it } from "vitest";
import { createEffectUnits } from "../packages/infra/src/audio/dsp/effects";

const SR = 48_000;

/** 阈值 -10 dBFS、压缩比 4:1；attack 1ms / release 50ms 让包络在 1 秒内进入稳态 */
function spec(kneeDb?: number) {
  return {
    kind: "compressor" as const,
    thresholdDb: -10,
    ratio: 4,
    attackMs: 1,
    releaseMs: 50,
    kneeDb,
  };
}

/** 输入 1 秒常量电平，返回末样本的稳态增益（越高电平越接近 1 表示压得越轻） */
function steadyGain(level: number, kneeDb?: number): number {
  const frames = SR;
  const [unit] = createEffectUnits([spec(kneeDb)], SR, 1);
  if (!unit) throw new Error("压缩器效果单元未创建");
  const buf = new Float32Array(frames).fill(level);
  unit.process(buf, frames);
  return buf[frames - 1]! / level;
}

/** dB 转线性幅度 */
function db2gain(db: number): number {
  return 10 ** (db / 20);
}

describe("压缩器拐点", () => {
  it("缺省硬拐点：阈值以下不压缩", () => {
    // 0.25 ≈ -12.04 dBFS，在 -10 dBFS 阈值以下
    expect(steadyGain(0.25)).toBe(1);
  });

  it("软拐点：阈值以下也开始轻微压缩，量按二次曲线折算", () => {
    // over = -2.0412 dB，knee = 12 → x = 3.9588，target = (1/4 - 1)·x²/(2·12) ≈ -0.4898 dB
    const expected = db2gain(((1 / 4 - 1) * 3.9588 ** 2) / (2 * 12));
    expect(steadyGain(0.25, 12)).toBeCloseTo(expected, 3);
    expect(steadyGain(0.25, 12)).toBeLessThan(1);
  });

  it("拐点上沿之外与硬拐点结果一致", () => {
    // 0.5 ≈ -6.02 dBFS，over ≈ 3.98 dB，knee = 6 时已越过上沿（x ≥ knee）
    expect(steadyGain(0.5, 6)).toBeCloseTo(steadyGain(0.5), 6);
  });
});
