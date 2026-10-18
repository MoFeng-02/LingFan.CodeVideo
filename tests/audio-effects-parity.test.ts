/**
 * 效果同源清点：同一条总线声明在预览端（WebAudio 节点）与导出端（就地 DSP）分别落到
 * 什么节点/系数上。记录型 AudioContext 见 `tests/support/audio-harness.ts`。
 *
 * 这里区分三档，而不是笼统地「一致」：
 * - 可证同源：两端读同一份声明，残差只由浮点/量化决定（延迟的延时量与反馈、效果链参数）；
 * - 算法不同但各自确定：混响（IR 卷积 vs 梳状-全通网络）；
 * - 语义不一致：程序化音源的声音速率在预览端没有落地——见 `audio-synth-tone-parity`。
 */
import { describe, expect, it } from "vitest";
import {
  delayBlock,
  gainById,
  graphOf,
  peakIndex,
  previewBus,
  reverbBlock,
  type FakeAudioBuffer,
  renderImpulse,
  SR,
} from "./support/audio-probes";

describe("效果同源：延迟", () => {
  it("延时量、反馈与干湿系数在两端读同一份声明", async () => {
    const graph = graphOf([
      {
        id: "fx",
        effects: [{ kind: "delay", delayMs: 180, feedback: 0.35, mix: 0.5 }],
      },
    ]);
    const h = await previewBus(graph);
    const block = delayBlock(h);
    expect(block.delay.maxDelayTime).toBe(5);
    expect(block.delay.delayTime.value).toBeCloseTo(0.18, 9);
    expect(block.fb.gain.value).toBeCloseTo(0.35, 9);
    expect(block.wet.gain.value).toBeCloseTo(0.5, 9);
    expect(block.dry.gain.value).toBeCloseTo(0.5, 9);

    // 缺省系数与导出端同一组缺省：feedback 0.3、mix 0.5
    const defaults = await previewBus(
      graphOf([{ id: "fx", effects: [{ kind: "delay", delayMs: 120 }] }]),
    );
    const db = delayBlock(defaults);
    expect(db.fb.gain.value).toBeCloseTo(0.3, 9);
    expect(db.wet.gain.value).toBeCloseTo(0.5, 9);

    // 两端各自把越界声明夹到同一区间
    const clamped = await previewBus(
      graphOf([
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs: 90, feedback: 2, mix: -1 }],
        },
      ]),
    );
    const cb = delayBlock(clamped);
    expect(cb.fb.gain.value).toBeCloseTo(0.95, 9);
    expect(cb.wet.gain.value).toBeCloseTo(0, 9);
    expect(cb.dry.gain.value).toBeCloseTo(1, 9);
  });

  it("延迟时序：预览的延时量与导出的环形缓冲同一处落点", async () => {
    for (const delayMs of [180, 180.3, 7.77, 1, 0.5]) {
      const graph = graphOf([
        {
          id: "fx",
          effects: [{ kind: "delay", delayMs, feedback: 0, mix: 1 }],
        },
      ]);
      const h = await previewBus(graph);
      const previewSamples = delayBlock(h).delay.delayTime.value * SR;
      const out = renderImpulse(graph);
      const exportSamples = peakIndex(out);
      // 导出端按采样取整，且至少留一个采样；预览端按秒给出精确延时
      expect(exportSamples).toBe(
        Math.max(1, Math.round((delayMs / 1000) * SR)),
      );
      if (delayMs >= 1) {
        // 量化残差不超过半个采样：两端指向同一个毫秒值
        expect(Math.abs(previewSamples - exportSamples)).toBeLessThanOrEqual(
          0.5,
        );
      } else {
        // 亚毫秒声明：预览端有 1ms 的下限，导出端只保留一个采样起步
        expect(previewSamples).toBeCloseTo(48, 9);
        expect(exportSamples).toBe(24);
        expect(Math.abs(previewSamples - exportSamples)).toBeCloseTo(24, 6);
      }
    }
  });

  it("反馈：两端的回声逐级衰减由同一个系数决定", async () => {
    const graph = graphOf([
      {
        id: "fx",
        effects: [{ kind: "delay", delayMs: 10, feedback: 0.35, mix: 1 }],
      },
    ]);
    const h = await previewBus(graph);
    expect(delayBlock(h).fb.gain.value).toBeCloseTo(0.35, 9);

    const out = renderImpulse(graph, { frames: SR / 4 });
    const step = Math.round(0.01 * SR);
    let previous = 0;
    for (let tap = 1; tap <= 4; tap++) {
      const value = Math.abs(out[step * tap * 2]!);
      // 两声道各走各的延迟线：右声道与左声道逐样本相同，不得读到对侧样本
      expect(out[step * tap * 2 + 1]!).toBe(out[step * tap * 2]!);
      if (tap === 1) expect(value).toBeCloseTo(1, 5);
      else expect(value).toBeCloseTo(previous * 0.35, 5);
      previous = value;
    }
    // 干声被 mix=1 完全替换：冲激时刻本身没有输出
    expect(Math.abs(out[0]!)).toBeLessThan(1e-6);
  });
});

describe("效果同源：混响", () => {
  it("两条 DSP 路径：预览是 IR 卷积，导出是梳状-全通网络，各自确定", async () => {
    const graph = graphOf([
      { id: "fx", effects: [{ kind: "reverb", roomSize: 0.7, mix: 0.8 }] },
    ]);
    const h = await previewBus(graph);
    const ir = reverbBlock(h).conv.buffer;
    if (!ir) throw new Error("预览端没有给卷积节点装 IR");
    // IR 长度由声明决定：0.6s 底 + roomSize × 1.6s
    expect(ir.length).toBe(Math.round((0.6 + 0.7 * 1.6) * SR));
    expect(ir.numberOfChannels).toBe(2);
    // 同一声明两次建图逐样本相同：预览端的随机尾巴是确定性种子给的
    const again = await previewBus(graph);
    const ir2 = reverbBlock(again).conv.buffer as FakeAudioBuffer;
    expect(Array.from(ir2.getChannelData(0))).toEqual(
      Array.from(ir.getChannelData(0)),
    );

    // 导出端同样确定，且确有尾音
    const a = renderImpulse(graph, { frames: SR * 2 });
    const b = renderImpulse(graph, { frames: SR * 2 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(
      Array.from(a).reduce((sum, v) => sum + Math.abs(v), 0),
    ).toBeGreaterThan(0.5);
  });

  it("同一声明在两端引起同向变化：房间越大，尾音越长", async () => {
    const lengths: number[] = [];
    const tails: number[] = [];
    for (const roomSize of [0.2, 0.85]) {
      const graph = graphOf([
        { id: "fx", effects: [{ kind: "reverb", roomSize, mix: 1 }] },
      ]);
      const h = await previewBus(graph);
      lengths.push(reverbBlock(h).conv.buffer!.length);
      const out = renderImpulse(graph, { frames: SR * 2 });
      let sum = 0;
      for (let i = Math.round(0.7 * SR); i < Math.round(0.9 * SR); i++) {
        sum += Math.abs(out[i * 2]!);
      }
      tails.push(sum);
    }
    expect(lengths[1]!).toBeGreaterThan(lengths[0]!);
    expect(tails[1]!).toBeGreaterThan(tails[0]!);
  });
});

describe("效果同源：链序", () => {
  it("预览按声明顺序串联，干湿并联在链尾，最后才进总线增益与声像", async () => {
    const graph = graphOf([
      {
        id: "music",
        parent: "fx",
        gain: 0.8,
        pan: -0.5,
        effects: [
          { kind: "filter", type: "highpass", frequency: 200, q: 0.9 },
          {
            kind: "compressor",
            thresholdDb: -20,
            ratio: 4,
            attackMs: 3,
            releaseMs: 120,
            kneeDb: 6,
          },
          { kind: "delay", delayMs: 60, feedback: 0.2, mix: 0.4 },
          { kind: "reverb", roomSize: 0.5, mix: 0.3 },
        ],
      },
      { id: "fx" },
    ]);
    const h = await previewBus(graph);
    const filter = h.biquads[0]!;
    const inputId = h.inputsOf(filter.id).find((id) => h.kindOf(id) === "gain");
    if (inputId === undefined) throw new Error("滤波器没有接到总线入口");
    const comp = h.compressors[0]!;
    const delay = h.delays[0]!;
    const reverb = h.convolvers[0]!;
    // 声明顺序即拓扑顺序
    expect(h.outputsOf(inputId)).toContain(filter.id);
    expect(h.outputsOf(filter.id)).toContain(comp.id);
    expect(h.outputsOf(comp.id)).toContain(delay.id);
    const delayOut = delayBlock(h);
    expect(h.outputsOf(delayOut.merge.id)).toContain(reverb.id);
    // 效果链之后才是总线增益与声像，再汇入父总线
    const busGain = h
      .outputsOf(reverbBlock(h).merge.id)
      .find((id) => h.kindOf(id) === "gain")!;
    const panner = h
      .outputsOf(busGain)
      .find((id) => h.kindOf(id) === "panner")!;
    expect(h.inputsOf(panner)).toContain(busGain);
    // 子总线：声像 → 父总线入口；父总线声像 → master 入口 → master 增益 → 扬声器
    const parentInputId = h
      .outputsOf(panner)
      .find((id) => h.kindOf(id) === "gain");
    if (parentInputId === undefined) throw new Error("子总线没有接入父总线");
    const masterGainId = h.gains.find((g) =>
      h.outputsOf(g.id).includes(-1),
    )!.id;
    const masterInputId = h
      .inputsOf(masterGainId)
      .find((id) => h.kindOf(id) === "gain")!;
    expect(h.inputsOf(masterInputId)).toHaveLength(1);
    const fxPanner = h.panners.find((p) => p.id !== panner);
    if (!fxPanner) throw new Error("父总线没有声像节点");
    expect(h.inputsOf(masterInputId)).toContain(fxPanner.id);

    // 参数映射：类型、频率、缺省 Q 与声明一致；压缩器把毫秒换算成秒
    expect(filter.type).toBe("highpass");
    expect(filter.frequency.value).toBe(200);
    expect(filter.Q.value).toBe(0.9);
    expect(comp.threshold.value).toBe(-20);
    expect(comp.ratio.value).toBe(4);
    expect(comp.attack.value).toBeCloseTo(0.003, 9);
    expect(comp.release.value).toBeCloseTo(0.12, 9);
    expect(comp.knee.value).toBe(6);
    expect(gainById(h, busGain).gain.value).toBeCloseTo(0.8, 9);
  });
});
