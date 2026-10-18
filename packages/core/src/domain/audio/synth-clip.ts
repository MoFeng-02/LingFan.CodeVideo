import type { AudioClip } from "@lingfan-video/contracts";

/**
 * 程序化音源的占位片段：`url` 是占位标识，不对应素材文件。
 *
 * 音频声明带 synth 规格时，样本在运行期由音源求值；占位片段只为让
 * 「声音 = 片段 + 选项」的形态对真实片段与合成音源保持一致。
 */
export const SYNTH_CLIP = { url: "synth:inline", kind: "audio" } as AudioClip;
