import type { AudioClip } from "@lingfan-video/contracts";

/** 程序化音源的占位片段（样本由 voice.synth 求值，不读素材） */
export const SYNTH_CLIP = { url: "synth:inline", kind: "audio" } as AudioClip;
