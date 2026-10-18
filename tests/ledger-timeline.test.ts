/**
 * 《刻度》的契约面测试：不整片渲染。
 *
 * 三章各自编译、各自算帧数；fn 直接给一刻就拿一帧；层与声音看登记结果；
 * 确定性用探针（四档采样各一段）比帧指纹序列。
 */
import { describe, expect, it } from "vitest";
import {
  compileAudioProgram,
  compute,
  render,
  start,
  validateScene,
} from "@lingfan-video/core";
import { FrameHasher } from "@lingfan-video/infra";
import type {
  Exporter,
  ExportResult,
  FrameCarrier,
  FrameHost,
  FrameHostInfo,
  Ms,
  StepContext,
} from "@lingfan-video/contracts";
import {
  CHAPTERS,
  CHAPTER_LENGTHS,
  CHAPTER_OVERLAP_MS,
  END_CARD,
  FIELD_CYCLE_MS,
  readingAt,
  SHOTS,
  STAMPS,
  TOTAL,
} from "../examples/browser/ledger/script";
import {
  buildProgram,
  picture,
  SCENES,
  shotFrame,
} from "../examples/browser/ledger/program";

/** 只收帧时间戳与指纹的导出器 */
class FrameCollector implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  readonly hasher = new FrameHasher();

  get stamps(): Ms[] {
    return this.hasher.hashes.map((hash) => hash.timestampMs);
  }

  get prints(): string[] {
    return this.hasher.hashes.map((hash) => hash.fingerprint);
  }

  async writeFrame(frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    void this.hasher.writeFrame(frame, this.hasher.hashes.length, timestampMs);
  }

  async finalize(): Promise<ExportResult> {
    return {
      output: "",
      frames: this.hasher.hashes.length,
      durationMs: 0,
      format: "frames",
    };
  }
}

/** 第一帧就停：只为拿 FrameHostInfo */
class StopFrames extends Error {}

class EarlyStopExporter implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;

  async writeFrame(): Promise<void> {
    throw new StopFrames();
  }

  async finalize(): Promise<ExportResult> {
    return { output: "", frames: 0, durationMs: 0, format: "frames" };
  }
}

class DeclHost implements FrameHost {
  info: FrameHostInfo | null = null;

  begin(info: FrameHostInfo): void {
    this.info = info;
  }

  frame(): FrameCarrier {
    return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  }
}

/** 探针：四档采样各 1 秒，共 300 帧 */
function buildProbe() {
  const root = start(1_000, (env) =>
    env.step(1_000, () => undefined, { fps: 30 }),
  );
  let tail = root;
  for (const fps of [60, 90, 120] as const)
    tail = tail.cutTo(1_000, (_prev, env) =>
      env.step(1_000, () => undefined, { fps }),
    );
  return root;
}

async function probeFingerprints(): Promise<FrameCollector> {
  const collector = new FrameCollector();
  await render(buildProbe(), {
    fps: 30,
    width: 1,
    height: 1,
    headless: true,
    frames: "allow-blank",
    exporter: collector,
  });
  return collector;
}

const START = (order: number): Ms =>
  SHOTS.slice(0, order).reduce((sum, shot) => sum + shot.length, 0);

describe("《刻度》剧本", () => {
  it("三章串成一条链：总长是各章之和减重叠", () => {
    expect(validateScene(picture)).toEqual([]);
    // 根段只声明自己那一章的窗口；总长由链算
    expect(picture.duration).toBe(CHAPTER_LENGTHS[0]);

    const sum = CHAPTER_LENGTHS.reduce((total, ms) => total + ms, 0);
    const overlap = CHAPTER_OVERLAP_MS.reduce((total, ms) => total + ms, 0);
    expect(TOTAL).toBe(sum - overlap);
  });

  it("每章可独立编译：帧数 = 各段窗口 × 各自采样密度", async () => {
    const plain = buildProgram({}, { cycle: false });
    expect(plain.scenes).toHaveLength(CHAPTER_LENGTHS.length);

    for (const [index, scene] of plain.scenes.entries()) {
      expect(validateScene(scene)).toEqual([]);
      expect(scene.duration).toBe(CHAPTER_LENGTHS[index]);
      const expected = CHAPTERS[index]!.reduce(
        (sum, shot) => sum + (shot.length * shot.fps) / 1000,
        0,
      );
      const frames = await compute.computeRange(
        scene,
        0,
        CHAPTER_LENGTHS[index]!,
      );
      expect(frames.length).toBe(expected);
    }
  });

  it("每章自带周期：loop 是后台重复，只多出它自己的采样点", async () => {
    for (const [index, scene] of SCENES.entries()) {
      const withCycle = await compute.computeRange(
        scene,
        0,
        CHAPTER_LENGTHS[index]!,
      );
      const plain = await compute.computeRange(
        buildProgram({}, { cycle: false }).scenes[index]!,
        0,
        CHAPTER_LENGTHS[index]!,
      );
      expect(withCycle.length).toBeGreaterThanOrEqual(plain.length);
    }
  });

  it("四档采样都在用，切点落在 100ms 网格", () => {
    expect(new Set(SHOTS.map((shot) => shot.fps))).toEqual(
      new Set([30, 60, 90, 120]),
    );
    for (const shot of SHOTS) expect(shot.length % 100).toBe(0);
  });

  it("fn 单测：给一刻就拿一帧，不建引擎", () => {
    const order = 9;
    const shot = SHOTS[order]!;
    const local = 500;
    const state = shotFrame(shot, order, 1, {
      t: 22_000,
      localT: local,
      duration: shot.length,
      progress: local / shot.length,
      fps: shot.fps,
    } as unknown as StepContext);

    expect(state.shot).toBe(shot.id);
    expect(state.fps).toBe(shot.fps);
    expect(state.local).toBe(local);
    expect(state.progress).toBeCloseTo(local / shot.length, 6);
    expect(state.code).toBe(shot.code ?? "");
  });

  it("读数按节奏上屏：到点才翻一页", () => {
    const order = SHOTS.findIndex((shot) => (shot.readings?.length ?? 0) > 0);
    const shot = SHOTS[order]!;
    const clock = (local: Ms) =>
      ({
        t: START(order) + local,
        localT: local,
        duration: shot.length,
      }) as unknown as StepContext;

    expect(shotFrame(shot, order, 1, clock(readingAt(0) - 1)).revealed).toBe(0);
    expect(shotFrame(shot, order, 1, clock(readingAt(0))).revealed).toBe(1);
  });

  it("同一图形的连续几镜共用一整段进度", () => {
    const order = SHOTS.findIndex(
      (shot, index) => index > 0 && SHOTS[index - 1]!.field === shot.field,
    );
    expect(order).toBeGreaterThan(0);
    const shot = SHOTS[order]!;
    const at = START(order) + 100;
    const state = shotFrame(shot, order, 1, {
      t: at,
      localT: 100,
      duration: shot.length,
    } as unknown as StepContext);
    // 图形进度只由引擎给的 t 取模得出：切镜不重播，也不读任何时间表
    expect(state.phase).toBeCloseTo((at % FIELD_CYCLE_MS) / FIELD_CYCLE_MS, 6);
  });

  it("画面按段声明两层：段内常在，下一段再声明一次", async () => {
    const host = new DeclHost();
    await expect(
      render(picture, {
        fps: 30,
        width: 640,
        height: 360,
        headless: true,
        frames: "allow-blank",
        painter: host,
        exporter: new EarlyStopExporter(),
      }),
    ).rejects.toBeInstanceOf(StopFrames);

    // 第 2→3 章是重叠过场：整片池比三段之和少一个重叠窗
    expect(host.info?.durationMs).toBe(TOTAL);

    const layers = host.info?.layers ?? [];
    expect(layers).toHaveLength(SHOTS.length * 2);
    // 层随段声明：id 唯一、成对，窗口落在整片之内（不写全片总长）
    for (const [index, shot] of SHOTS.entries()) {
      const field = layers[index * 2]!;
      const type = layers[index * 2 + 1]!;
      expect(field.id).toBe(`field:${shot.id}`);
      expect(type.id).toBe(`type:${shot.id}`);
      expect(type.from).toBe(field.from);
      expect(type.to).toBe(field.to);
      expect(field.from!).toBeGreaterThanOrEqual(0);
      expect(field.to!).toBeGreaterThan(field.from!);
      expect(field.to!).toBeLessThanOrEqual(TOTAL);
      expect(type.z ?? 0).toBeGreaterThan(field.z ?? 0);
    }
  });

  it("声音全是程序化声部，落点都在片长内，且留了两处空档", async () => {
    const audio = await compileAudioProgram(picture, {
      fps: 30,
      width: 1,
      height: 1,
    });

    expect(audio.voices.length).toBeGreaterThan(120);
    for (const voice of audio.voices) {
      expect(voice.synth).toBeDefined();
      expect(voice.startMs).toBeGreaterThanOrEqual(0);
      expect(voice.startMs).toBeLessThan(TOTAL);
    }

    const starts = [
      ...new Set(audio.voices.map((voice) => voice.startMs)),
    ].sort((a, b) => a - b);
    const gaps = starts.filter(
      (at, index) => index > 0 && at - starts[index - 1]! >= 600,
    );
    expect(gaps.length).toBeGreaterThanOrEqual(2);
  });

  it("十二枚印章按出现顺序挂在刻度尺上，代号不重复", () => {
    expect(STAMPS).toHaveLength(12);
    expect(new Set(STAMPS.map((stamp) => stamp.code)).size).toBe(12);
    // 印章不存时刻，只按出现顺序挂在刻度尺上；位置由二维层按序号均分
    for (const stamp of STAMPS) {
      expect(SHOTS.some((shot) => shot.id === stamp.shot)).toBe(true);
    }
  });

  it("落版只写段内偏移，且都落在最后一段窗口里", () => {
    expect(END_CARD.window).toBe(SHOTS.at(-1)!.length);
    const offsets = [...Object.values(END_CARD.at).flat(), END_CARD.out];
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(END_CARD.window);
    }
  });

  it("确定性：探针推两遍，帧时间戳与指纹序列一致", async () => {
    const first = await probeFingerprints();
    const second = await probeFingerprints();

    expect(first.stamps).toHaveLength(300);
    expect(second.stamps).toEqual(first.stamps);
    expect(second.prints).toEqual(first.prints);
  });

  it("可计算：同一刻求两次状态相等", async () => {
    for (const at of [0, 4_700, 22_100, 59_000, 88_500]) {
      const once = await compute.computeAt(picture, at);
      const twice = await compute.computeAt(picture, at);
      expect(twice).toEqual(once);
    }
  });
});
