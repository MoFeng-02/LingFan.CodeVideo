/**
 * 配乐：120 BPM，按段写响动——每一句只说「哪一段、段内第几毫秒」。
 * 动态按章给，音高/重音来自 `motifs.ts`；没有任何全片绝对时刻表。
 */
import { BEAT_MS, CHAPTERS, END_CARD, type Shot } from "../script";
import { levelOfChapter } from "./level";
import {
  ACCENT_POWER,
  CLOSE_NOTES,
  DRONE_ROOTS,
  NOISE_SWEEPS,
  PAD_CHORDS,
  PING_CUTS,
  STAMP_PITCHES,
} from "./motifs";
import { GRID, rounded } from "./silence";
import type { Cue, CueKind } from "./types";

function buildCues(): readonly Cue[] {
  const cues: Cue[] = [];
  const push = (
    shot: Shot,
    localAt: number,
    kind: CueKind,
    power: number,
    tag: string,
    freq?: number,
  ): void => {
    const at = Math.round(localAt / GRID) * GRID;
    if (at < 0 || at >= shot.length) return;
    const entry: Cue = {
      shot: shot.id,
      localAt: at,
      kind,
      power: rounded(Math.max(0.02, Math.min(1, power))),
      tag,
      ...(freq === undefined ? {} : { freq }),
    };
    cues.push(entry);
  };

  let version = 0;

  for (const [chapter, shots] of CHAPTERS.entries()) {
    for (const [index, shot] of shots.entries()) {
      const level = levelOfChapter(chapter, shot.accent);

      // 低频：每章起一条长音，根音换一次
      if (index === 0)
        push(
          shot,
          0,
          "drone",
          level * 0.5,
          `drone-c${chapter}`,
          DRONE_ROOTS[chapter],
        );

      // 版本印章：落在有代号的段首，一声比一声高
      if (typeof shot.code === "string") {
        const pitch = STAMP_PITCHES[version % STAMP_PITCHES.length] ?? 220;
        push(
          shot,
          200,
          "stamp",
          rounded(0.32 + version * 0.015),
          `stamp-${shot.code}`,
          pitch,
        );
        version += 1;
      }

      // 刻度尺走针：仪器在走的段，一拍一点
      if (shot.mode === "version" || shot.mode === "event")
        for (let at = 0; at < shot.length; at += BEAT_MS)
          push(
            shot,
            at,
            "tick",
            0.04 + ((at / BEAT_MS) % 3) * 0.005,
            `tick-${shot.id}-${at}`,
            1_180 + ((at / BEAT_MS) % 4) * 60,
          );

      // 垫底和弦：第二章起，两秒一换
      if (chapter >= 1)
        for (let at = 0; at < shot.length; at += 2_000) {
          const chord =
            PAD_CHORDS[
              (chapter * 4 + index + at / 2_000) % PAD_CHORDS.length
            ] ?? [];
          for (const [note, freq] of chord.entries())
            push(
              shot,
              at + note * GRID,
              "pad",
              rounded(0.12 + level * 0.2),
              `pad-${shot.id}-${at}-${note}`,
              freq,
            );
        }

      // 重击与刀口
      const accent = ACCENT_POWER[shot.id];
      if (accent !== undefined)
        push(shot, 0, "impact", accent, `impact-${shot.id}`);
      const ping = PING_CUTS[shot.id];
      if (ping) push(shot, 0, "ping", ping[0], `ping-${shot.id}`, ping[1]);

      // 噪声扫过：只落在有"施工/生成"意味的段
      if (shot.mode === "works" || shot.mode === "event")
        for (const [, power, freq] of NOISE_SWEEPS)
          push(
            shot,
            shot.length * 0.25,
            "noise",
            power * level,
            `noise-${shot.id}`,
            freq,
          );
    }
  }

  // 收尾：最后一段的一声长音与 stop
  const last = CHAPTERS[CHAPTERS.length - 1]!.at(-1)!;
  for (const [freq, power] of CLOSE_NOTES)
    push(last, END_CARD.at.line, "pad", power, `close-${freq}`, freq);
  push(last, END_CARD.out, "stop", 0.8, "stop-out", 41);

  return cues;
}

export const CUES: readonly Cue[] = buildCues();
