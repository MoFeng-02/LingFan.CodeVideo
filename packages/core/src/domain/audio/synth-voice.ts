import type { AudioOptions, SynthSpec } from "@lingfan-video/contracts";

/**
 * 把程序化音源映射成声音选项。
 *
 * 音量只属于声音本身（`spec.gain`，合成时乘一次）；时间线侧另有 voice 的增益包络
 * （缺省 1，`setGain`/`kill` 在其上叠乘）。因此这里不把 `spec.gain` 复制到 voice 上，
 * 否则同一个数字会被乘两次。
 *
 * 登记期 `env.synth` 与运行期 `ctx.synth` 共用这一处映射，两处入口的语义因此只有一份。
 *
 * @param spec 音源规格
 * @returns 声音选项：只带摆位（缺省居中）与可选总线；不含增益
 */
export function synthVoiceOptions(spec: SynthSpec): AudioOptions {
  return {
    pan: { value: spec.pan ?? 0 },
    ...(spec.bus ? { bus: spec.bus } : {}),
  };
}
