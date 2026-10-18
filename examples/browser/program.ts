/**
 * 这支 MV 的剧本：一条时间线，两层画面，一条声轨。
 *
 * 三层分工（也是"多后端"的实际形态）：
 * - **三维层**（`stage3d.ts`）：一块 WebGL 画布，画空间与运动；
 * - **二维文字层**（`layer2d.ts`）：一块 2D 画布，画字、卡、落版；
 * - **合成**：由宿主按 z 叠起来（GPU 四边形或 CPU `drawImage`，可选）。
 *
 * 音轨是歌本身（`assets/song.mp3`）+ `sfx.ts` 里的声音设计，全部现场合成。
 * 采样密度按段切：主体 30fps，运动段 60fps，破墙那一下 120fps。
 */
import { clip, createScene, gain } from "@lingfan-video/core";
import type { SceneEnv } from "@lingfan-video/contracts";
import { SONG_URL } from "./song-audio";
import { CUES, type Cue } from "./mv/sfx";
import { ACTS, LAST_ACT_END, SONG_END, TOTAL, actFrom } from "./mv/timeline";

/** 巴士：歌一路平推，音效挂在自己的总线上，铃与扫频送到延迟里 */
function buildBuses(env: SceneEnv): void {
  env.bus({ id: "song", gain: 0.92 });
  env.bus({ id: "sfx", gain: 0.34 });
  env.bus({
    id: "echo",
    effects: [{ kind: "delay", delayMs: 187, feedback: 0.28, mix: 0.42 }],
  });
  env.bus({
    id: "hall",
    effects: [{ kind: "reverb", roomSize: 0.8, damping: 0.45, mix: 0.5 }],
  });
  env.send({ from: "sfx", to: "echo", amount: 0.45 });
  env.send({ from: "sfx", to: "hall", amount: 0.3 });
  // 冲击一起，把歌压一点：让"响"落在该响的地方
  env.duck({
    from: "sfx",
    to: "song",
    amountDb: 3.5,
    attackMs: 8,
    holdMs: 60,
    releaseMs: 180,
  });
}

/** 一种响动 → 一个合成声部（全部无素材：波形 + 包络） */
function voiceOf(cue: Cue): Parameters<SceneEnv["synth"]>[0] {
  const p = cue.power;
  switch (cue.kind) {
    case "impact":
      return {
        wave: "sine",
        freq: 46 + p * 8,
        durationMs: 900 + p * 500,
        gain: 0.16 * p + 0.05,
        bus: "sfx",
        envelope: { attackMs: 6, decayMs: 420, sustain: 0.12, releaseMs: 420 },
      };
    case "riser":
      return {
        wave: "noise",
        freq: 300,
        durationMs: 900,
        gain: 0.05,
        bus: "sfx",
        envelope: { attackMs: 700, decayMs: 120, sustain: 0.3, releaseMs: 60 },
      };
    case "tick":
      return {
        wave: "triangle",
        freq: 1280 + p * 500,
        durationMs: 70,
        gain: 0.035 * (0.5 + p),
        bus: "sfx",
        envelope: { attackMs: 2, decayMs: 60, sustain: 0, releaseMs: 8 },
      };
    case "ping":
      return {
        wave: "sine",
        freq: 1760 + p * 220,
        durationMs: 1100,
        gain: 0.05 * (0.5 + p),
        bus: "echo",
        envelope: { attackMs: 4, decayMs: 900, sustain: 0, releaseMs: 160 },
      };
    case "drone":
      return {
        wave: "sine",
        freq: 55,
        durationMs: 5200,
        gain: 0.09,
        bus: "sfx",
        envelope: {
          attackMs: 900,
          decayMs: 1800,
          sustain: 0.35,
          releaseMs: 1200,
        },
      };
    case "sweep":
      return {
        wave: "noise",
        freq: 1800,
        durationMs: 700,
        gain: 0.075 * p,
        bus: "hall",
        envelope: { attackMs: 30, decayMs: 500, sustain: 0.2, releaseMs: 140 },
      };
    case "stop":
      return {
        wave: "sine",
        freq: 41,
        durationMs: 2600,
        gain: 0.2,
        bus: "hall",
        envelope: { attackMs: 8, decayMs: 900, sustain: 0.1, releaseMs: 1500 },
      };
  }
}

/** 声音设计分支：按表走，两个响动之间用 wait 跳过空档 */
function scheduleSfx(env: SceneEnv): void {
  let cursor = 0;
  for (const cue of CUES) {
    const at = Math.max(cue.at, 0);
    if (at > cursor) {
      env.wait(at - cursor);
      cursor = at;
    }
    env.synth(voiceOf(cue));
  }
  if (cursor < SONG_END) env.wait(SONG_END - cursor);
}

/**
 * 破墙那一下单独提到 120fps：只有 700ms，代价小，
 * 但它决定了"炸开"这个动作有没有重量。
 */
const FLASH = {
  from: actFrom("open").from + 500,
  to: actFrom("open").from + 1200,
};

/** 画面分支：逐段推进，每段用自己的采样密度（变帧率） */
function schedulePicture(env: SceneEnv): void {
  for (const act of ACTS) {
    if (act.id === "open") {
      // 破墙段拆成三段：入 60 → 炸 120 → 出 60
      env.step(FLASH.from - act.from, () => undefined, { fps: 60 });
      env.step(FLASH.to - FLASH.from, () => undefined, { fps: 120 });
      env.step(act.to - FLASH.to, () => undefined, { fps: 60 });
      continue;
    }
    env.step(act.to - act.from, () => undefined, { fps: act.fps });
  }
  // 落版：歌停了，画面再站 3.6 秒
  env.step(TOTAL - LAST_ACT_END, () => undefined, { fps: 30 });
}

export const picture = createScene(TOTAL, (_prev, env) => {
  buildBuses(env);
  env.audio(clip(SONG_URL), { at: 0, gain: gain(0.9), bus: "song" });
  env.par([(b) => scheduleSfx(b), (b) => schedulePicture(b)]);
});

/** 预览与导出共用同一个入口 */
export const mv = picture;
