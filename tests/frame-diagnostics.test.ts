/**
 * 确定性校验与动画连贯性度量：AI 调试要能看见「帧是否算得一样、动作是否连贯」。
 * 覆盖指纹、整段摘要、帧间差异、连贯性报告、旁路 sink 与两遍比对。
 */
import { describe, expect, it } from "vitest";
import type { FrameBitmap } from "@lingfan-video/contracts";
import {
  FrameHasher,
  MemoryFrameSink,
  auditDeterminism,
  compareFrameHashes,
  compareFingerprints,
  continuityReport,
  frameDelta,
  frameFingerprint,
  sequenceFingerprint,
} from "@lingfan-video/infra";

const W = 4;
const H = 2;

/** 用灰度填充一帧：gray(i) 决定每个像素亮度，便于合成「匀速移动 / 突跳」 */
function bitmap(gray: (pixel: number) => number, width = W, height = H) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const value = gray(p);
    data[p * 4] = value;
    data[p * 4 + 1] = value;
    data[p * 4 + 2] = value;
    data[p * 4 + 3] = 255;
  }
  return { data, width, height };
}

function solid(value: number): FrameBitmap {
  return bitmap(() => value);
}

describe("帧指纹", () => {
  it("同像素同指纹，改一个像素即变，尺寸参与指纹", () => {
    expect(frameFingerprint(solid(10))).toBe(frameFingerprint(solid(10)));
    expect(frameFingerprint(solid(10))).not.toBe(frameFingerprint(solid(11)));
    const wide = bitmap(() => 10, W + 1, H);
    expect(frameFingerprint(wide)).not.toBe(frameFingerprint(solid(10)));
  });

  it("整段指纹：序列相同则相同，任一帧不同则不同", () => {
    const a = [solid(1), solid(2), solid(3)].map(frameFingerprint);
    const b = [solid(1), solid(2), solid(3)].map(frameFingerprint);
    const c = [solid(1), solid(2), solid(4)].map(frameFingerprint);
    expect(sequenceFingerprint(a)).toBe(sequenceFingerprint(b));
    expect(sequenceFingerprint(a)).not.toBe(sequenceFingerprint(c));
  });
});

describe("帧间差异", () => {
  it("完全相同 → 全 0；单像素改动 → 变化占比与差值可算", () => {
    const same = frameDelta(solid(0), solid(0));
    expect(same).toEqual({ meanAbsDiff: 0, maxAbsDiff: 0, changedRatio: 0 });
    const one = frameDelta(
      solid(0),
      bitmap((p) => (p === 0 ? 255 : 0)),
    );
    expect(one.maxAbsDiff).toBe(255);
    expect(one.changedRatio).toBeCloseTo(1 / (W * H), 10);
    // RGB 三通道各差 255、alpha 不变：765 / (8 像素 × 4 通道)
    expect(one.meanAbsDiff).toBeCloseTo((255 * 3) / (W * H * 4), 10);
  });

  it("尺寸不一致 → spec_violation", () => {
    expect(() =>
      frameDelta(
        solid(0),
        bitmap(() => 0, W + 1, H),
      ),
    ).toThrow(/spec_violation/);
  });
});

describe("连贯性报告", () => {
  it("匀速移动没有尖峰；切镜被识别为尖峰且平滑度变差", () => {
    const ramp = [0, 20, 40, 60, 80].map((value) => solid(value));
    const smooth = continuityReport(ramp);
    expect(smooth.spikeIndices).toEqual([]);
    expect(smooth.deltas).toHaveLength(4);
    // 每题 3 个颜色通道各差 20、alpha 不变 → 均值 15
    expect(smooth.maxDelta).toBeCloseTo(15, 10);
    expect(smooth.smoothness).toBeCloseTo(0, 10);

    const cut = [0, 20, 40, 240, 250].map((value) => solid(value));
    const jumped = continuityReport(cut);
    expect(jumped.spikeIndices.length).toBeGreaterThan(0);
    expect(jumped.spikeIndices).toContain(2);
    expect(jumped.smoothness).toBeGreaterThan(smooth.smoothness);
  });

  it("单帧序列不报错，返回空序列；spikeFactor 非正数 → spec_violation", () => {
    const single = continuityReport([solid(0)]);
    expect(single.frames).toBe(1);
    expect(single.deltas).toEqual([]);
    expect(single.spikeIndices).toEqual([]);
    expect(() =>
      continuityReport([solid(0), solid(1)], { spikeFactor: 0 }),
    ).toThrow(/spec_violation/);
  });
});

describe("旁路哈希与两遍比对", () => {
  it("FrameHasher 逐帧记指纹并原样转发下游", async () => {
    const downstream = new MemoryFrameSink();
    const hasher = new FrameHasher(downstream);
    const frames = [solid(1), solid(2)];
    for (const [index, frame] of frames.entries()) {
      await hasher.writeFrame(frame, index, index * 100);
    }
    await hasher.finalize();
    expect(downstream.frames).toHaveLength(2);
    expect(downstream.frames[0]).toBe(frames[0]);
    expect(hasher.fingerprints()).toEqual(frames.map(frameFingerprint));
    expect(hasher.hashes[1]!.timestampMs).toBe(100);
  });

  it("compareFingerprints：相同 → identical；不同 → 报第一处不同并受上限约束", () => {
    const same = compareFingerprints(["a", "b"], ["a", "b"]);
    expect(same.identical).toBe(true);
    expect(same.mismatches).toEqual([]);

    const diff = compareFingerprints(["a", "b", "c"], ["a", "x", "y"], {
      maxMismatches: 1,
    });
    expect(diff.identical).toBe(false);
    expect(diff.frames).toBe(3);
    expect(diff.mismatches).toHaveLength(1);
    expect(diff.mismatches[0]).toEqual({ at: 1, expected: "b", actual: "x" });

    const shorter = compareFingerprints(["a", "b"], ["a"]);
    expect(shorter.identical).toBe(false);
    expect(shorter.mismatches[0]).toEqual({
      at: 1,
      expected: "b",
      actual: "<缺帧>",
    });
  });

  it("compareFrameHashes 与 auditDeterminism：同一次推演跑两遍必须完全一致", async () => {
    const run = async () => {
      const sink = new MemoryFrameSink();
      for (let i = 0; i < 3; i++) sink.writeFrame(solid(i), i, i * 100);
      await sink.finalize();
      return sink.frames;
    };
    const report = await auditDeterminism(run);
    expect(report.identical).toBe(true);
    expect(report.frames).toBe(3);
    expect(report.expected).toBe(report.actual);

    const hasherA = new FrameHasher();
    const hasherB = new FrameHasher();
    await hasherA.writeFrame(solid(0), 0, 0);
    await hasherB.writeFrame(solid(0), 0, 0);
    expect(compareFrameHashes(hasherA.hashes, hasherB.hashes).identical).toBe(
      true,
    );
  });
});
