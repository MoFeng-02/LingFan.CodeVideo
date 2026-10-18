/**
 * MV《千年之后》作为"测试素材"：把一部完整作品钉在几个可复算的断言上。
 *
 * 它守住五件事：
 * ① 剧本自洽——`validateScene` 无违规，段落首尾相接铺满全片；
 * ② 帧网格——基准 30fps，运动段 60fps，破墙那一下 120fps，
 *    全片真的混着三种步长（变帧率不是口号），且每步都是归一化后的整步长；
 * ③ 总时长——歌 134.298s + 落版定格，末帧时间戳就是片长；
 * ④ 声部——歌本身作为一条 clip 进程序，另有一批现场合成的音效；
 * ⑤ 确定性——同一剧本推两遍，帧时间戳与声部表必须逐项一致。
 *
 * 断言都落在"外部可观察量"上（帧时间戳、声音起播、剧本表本身），
 * 不依赖任何一层内部实现：换后端、换合成路径，只要片子没变，断言就不该变。
 */
import { describe, expect, it } from "vitest";
import {
  compileAudioProgram,
  render,
  validateScene,
} from "@lingfan-video/core";
import type {
  AudioOutput,
  ExportResult,
  Exporter,
  FrameCarrier,
  LiveVoice,
  Ms,
} from "@lingfan-video/contracts";
import { picture } from "../examples/browser/program";
import { ACTS, END_CARD, TOTAL } from "../examples/browser/mv/timeline";
import { SONG_URL } from "../examples/browser/song-audio";

/** 只记时间戳、丢位图的导出器。 */
class StampExporter implements Exporter {
  readonly impl = "frames" as const;
  readonly format = "frames" as const;
  frames: Ms[] = [];
  async writeFrame(_frame: FrameCarrier, timestampMs: Ms): Promise<void> {
    this.frames.push(timestampMs);
  }
  async finalize(): Promise<ExportResult> {
    return {
      output: "",
      frames: this.frames.length,
      durationMs: this.frames.at(-1) ?? 0,
      format: "frames",
    };
  }
}

/** 只记程序里登记了多少声部，不出声。 */
class CountingOutput implements AudioOutput {
  voices = 0;
  begin(program: Parameters<AudioOutput["begin"]>[0]): Promise<void> {
    this.voices += program.voices.length;
    return Promise.resolve();
  }
  start(): LiveVoice {
    return {
      stop: () => undefined,
      setGain: () => undefined,
      setRate: () => undefined,
    };
  }
  dispose(): void {
    /* 无资源可释放 */
  }
  nowMs(): Ms {
    return 0;
  }
}

async function runOnce(): Promise<{ stamps: Ms[]; voices: number }> {
  const exporter = new StampExporter();
  const output = new CountingOutput();
  await render(picture, {
    fps: 30,
    width: 640,
    height: 360,
    exporter,
    audioOutput: output,
    headless: true,
    frames: "allow-blank",
  });
  return { stamps: exporter.frames, voices: output.voices };
}

/** 归一化：浮点步长按 1e-3 精度归到整毫秒的倒数。 */
function stepOf(a: Ms, b: Ms): number {
  return 1000 / Math.round(1000 / (b - a));
}

describe("MV《千年之后》", () => {
  it("剧本自洽：无违规，段落首尾相接", () => {
    expect(validateScene(picture)).toEqual([]);
    expect(ACTS[0]!.from).toBe(0);
    for (let i = 1; i < ACTS.length; i += 1) {
      expect(ACTS[i]!.from).toBe(ACTS[i - 1]!.to);
    }
    expect(ACTS.at(-1)!.to).toBe(END_CARD.from);
    expect(END_CARD.to).toBe(TOTAL);
  });

  it("帧网格只有 30 / 60 / 120 三种步长", async () => {
    const { stamps } = await runOnce();
    // 歌 134.298s：30fps 主体 + 60fps 运动段 + 120fps 那 0.7 秒
    expect(stamps.length).toBeGreaterThan(4000);
    expect(stamps.length).toBeLessThan(6000);
    expect(stamps[0]!).toBeLessThan(10); // 歌的第一拍在 7ms；推演从零附近起步
    expect(stamps.at(-1)!).toBeGreaterThan(TOTAL - 60);
    expect(stamps.at(-1)!).toBeLessThanOrEqual(TOTAL);

    const steps = new Set<string>();
    for (let i = 1; i < stamps.length; i += 1) {
      const step = stepOf(stamps[i - 1]!, stamps[i]!);
      steps.add(step.toFixed(3));
      // 每一步都必须恰好是某档帧率的整步长（不允许出现 40fps 这种拼缝）
      expect(
        [8.333, 16.667, 33.333].some((ms) => Math.abs(step - ms) < 0.002),
      ).toBe(true);
    }
    // 三种步长真的都出现过
    expect([...steps].sort()).toEqual(["16.667", "33.333", "8.333"]);
  });

  it("声部：歌自己是一条 clip，音效是现场合成的", async () => {
    const program = await compileAudioProgram(picture, {
      fps: 30,
      width: 640,
      height: 360,
    });
    const song = program.voices.filter((voice) => voice.clip.url === SONG_URL);
    expect(song.length).toBe(1);
    expect(song[0]!.startMs).toBe(0);
    // 歌之外还要有声音设计，而不是"只有歌"
    expect(program.voices.length).toBeGreaterThan(10);
    for (const voice of program.voices) {
      expect(voice.startMs).toBeGreaterThanOrEqual(0);
      expect(voice.startMs).toBeLessThan(TOTAL);
    }
  });

  it("推两遍：帧时间戳逐项一致", async () => {
    const a = await runOnce();
    const b = await runOnce();
    expect(b.stamps).toEqual(a.stamps);
    expect(b.voices).toBe(a.voices);
  });
});
