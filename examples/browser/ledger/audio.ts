/**
 * 声音：总线图、声部表、按章登记响动。
 *
 * 声音不是"配乐铺底"，是仪器的读数声：动态由 `score.ts` 的表给，
 * 这里只负责把表喂给引擎，并在切点上让低频互相让路。
 */
import type { SceneEnv } from "@lingfan-video/contracts";
import { CUES, VOICE, type Cue } from "./score";
import { CHAPTERS } from "./script";

/** 总线：一条声音走一条线，空间类总线只收发送 */
const BUS: Record<
  string,
  {
    readonly gain: number;
    readonly sendHall?: number;
    readonly sendEcho?: number;
  }
> = {
  drone: { gain: 0.5, sendHall: 0.3 },
  pad: { gain: 0.42, sendHall: 0.35 },
  tick: { gain: 0.16 },
  stamp: { gain: 0.5, sendEcho: 0.35 },
  impact: { gain: 0.55, sendHall: 0.3 },
  ping: { gain: 0.34, sendEcho: 0.45 },
  noise: { gain: 0.24, sendHall: 0.42 },
};

/** 链首声明一次：总线、发送、避让都是全片共享的图 */
export function buildBuses(env: SceneEnv): void {
  env.bus({
    id: "hall",
    effects: [{ kind: "reverb", roomSize: 0.86, damping: 0.4, mix: 0.5 }],
  });
  env.bus({
    id: "echo",
    effects: [{ kind: "delay", delayMs: 250, feedback: 0.22, mix: 0.38 }],
  });

  for (const [id, config] of Object.entries(BUS)) {
    env.bus({ id, gain: config.gain });
    if (config.sendHall)
      env.send({ from: id, to: "hall", amount: config.sendHall });
    if (config.sendEcho)
      env.send({ from: id, to: "echo", amount: config.sendEcho });
  }

  // 重击落下时把长音让开：低频不打架，重击才像"砸"而不是"糊"
  env.duck({
    from: "impact",
    to: "drone",
    amountDb: 5,
    attackMs: 5,
    holdMs: 90,
    releaseMs: 260,
  });
  env.duck({
    from: "impact",
    to: "pad",
    amountDb: 4,
    attackMs: 5,
    holdMs: 80,
    releaseMs: 240,
  });
}

/** 一种响动 → 一个合成声部：波形与包络写在表里，这里只按力度缩放 */
function voiceOf(cue: Cue): Parameters<SceneEnv["synth"]>[0] {
  const voice = VOICE[cue.kind]!;
  return {
    wave: voice.wave,
    freq: cue.freq ?? 220,
    durationMs: voice.durationMs,
    gain: voice.gain * (0.35 + cue.power * 0.85),
    bus: voice.bus,
    envelope: voice.envelope,
  };
}

/** 声音分支：只登记落在本章的响动，按章内偏移用 wait 跳过空档 */
export function scheduleChapter(env: SceneEnv, chapterIndex: number): void {
  const chapter = CHAPTERS[chapterIndex]!;
  const indexOf = new Map(chapter.map((shot, index) => [shot.id, index]));
  // 章内偏移 = 本段之前各段长度之和 + 段内偏移；只用剧本自己声明的窗口长度
  const baseOf = (index: number): number =>
    chapter.slice(0, index).reduce((sum, shot) => sum + shot.length, 0);

  let cursor = 0;
  for (const cue of CUES) {
    const index = indexOf.get(cue.shot);
    if (index === undefined) continue;
    const at = baseOf(index) + cue.localAt;
    if (at > cursor) {
      env.wait(at - cursor);
      cursor = at;
    }
    env.synth(voiceOf(cue));
  }
}
