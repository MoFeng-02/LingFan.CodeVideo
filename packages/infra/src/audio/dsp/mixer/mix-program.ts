/**
 * 整段渲染：建一个流式内核，按块循环写完输出缓冲（导出端与测试用）。
 */
import { StreamingMixer } from "./streaming-mixer";
import { DEFAULT_BLOCK_FRAMES, type MixProgramInput } from "./types";

/**
 * 整段渲染：建一个内核、按块循环写完输出缓冲（导出端与测试用）。
 *
 * 输出帧数 = ceil(durationMs / 1000 × sampleRate)（至少 1 帧），布局为交错立体声/多声道；
 * 与预览端逐块渲染共用同一内核，因此两端结果逐样本一致。
 *
 * @param input 构造参数 + 全部声音
 * @returns 交错样本（长度 = 帧数 × 声道数）
 */
export function mixProgram(input: MixProgramInput): Float32Array {
  const ch = input.channels;
  /** 输出总帧数（至少 1 帧） */
  const frames = Math.max(
    1,
    Math.ceil((input.durationMs / 1000) * input.sampleRate),
  );
  const blockFrames = Math.max(1, input.blockFrames ?? DEFAULT_BLOCK_FRAMES);
  const mixer = new StreamingMixer({ ...input, blockFrames });
  for (const voice of input.voices) mixer.addVoice(voice);
  const out = new Float32Array(frames * ch);
  for (let start = 0; start < frames; start += blockFrames) {
    const n = Math.min(blockFrames, frames - start);
    mixer.renderBlock(start, n, out.subarray(start * ch, (start + n) * ch));
  }
  return out;
}
