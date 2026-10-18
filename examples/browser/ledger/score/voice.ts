/** 每种响动的合成声部：波形、包络、时长、总线。 */
import type { CueKind } from "./types";
export const VOICE: Record<
  CueKind,
  {
    wave: "sine" | "triangle" | "square" | "noise";
    durationMs: number;
    gain: number;
    bus: string;
    envelope: {
      attackMs: number;
      decayMs: number;
      sustain: number;
      releaseMs: number;
    };
  }
> = {
  drone: {
    wave: "sine",
    durationMs: 6_000,
    gain: 0.12,
    bus: "drone",
    envelope: {
      attackMs: 1_200,
      decayMs: 1_600,
      sustain: 0.4,
      releaseMs: 1_800,
    },
  },
  pad: {
    wave: "triangle",
    durationMs: 1_800,
    gain: 0.08,
    bus: "pad",
    envelope: { attackMs: 220, decayMs: 500, sustain: 0.34, releaseMs: 900 },
  },
  tick: {
    wave: "square",
    durationMs: 60,
    gain: 0.09,
    bus: "tick",
    envelope: { attackMs: 1, decayMs: 45, sustain: 0, releaseMs: 12 },
  },
  stamp: {
    wave: "triangle",
    durationMs: 90,
    gain: 0.18,
    bus: "stamp",
    envelope: { attackMs: 1, decayMs: 60, sustain: 0, releaseMs: 20 },
  },
  impact: {
    wave: "sine",
    durationMs: 900,
    gain: 0.34,
    bus: "impact",
    envelope: { attackMs: 3, decayMs: 420, sustain: 0.08, releaseMs: 460 },
  },
  ping: {
    wave: "sine",
    durationMs: 900,
    gain: 0.1,
    bus: "ping",
    envelope: { attackMs: 2, decayMs: 600, sustain: 0, releaseMs: 280 },
  },
  noise: {
    wave: "noise",
    durationMs: 1_200,
    gain: 0.055,
    bus: "noise",
    envelope: { attackMs: 120, decayMs: 700, sustain: 0.12, releaseMs: 300 },
  },
  kick: {
    wave: "sine",
    durationMs: 220,
    gain: 0.2,
    bus: "impact",
    envelope: { attackMs: 2, decayMs: 180, sustain: 0, releaseMs: 35 },
  },
  hat: {
    wave: "noise",
    durationMs: 70,
    gain: 0.07,
    bus: "noise",
    envelope: { attackMs: 1, decayMs: 50, sustain: 0, releaseMs: 18 },
  },
  stop: {
    wave: "sine",
    durationMs: 1_400,
    gain: 0.24,
    bus: "drone",
    envelope: { attackMs: 6, decayMs: 500, sustain: 0.12, releaseMs: 900 },
  },
};
