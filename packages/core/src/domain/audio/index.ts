/**
 * 音频域出口：组合子（构造期校验的参数值）、形式判据（登记期与静态校验共用）、
 * 增益单位换算，以及声音/音源映射。
 */
export {
  clip,
  curve,
  fadeIn,
  fadeOut,
  gain,
  pan,
  loop,
  ramp,
  rate,
  warp,
  makeVoice,
  normalizeOptions,
  DEFAULT_GAIN,
  DEFAULT_PAN,
} from "./combinators";
export { assertAutomation, automationErrors } from "./automation";
export { dbToLinear, gainError, toLinearGain } from "./gain-units";
export { assertSynth, synthErrors } from "./synth-spec";
export { synthVoiceOptions } from "./synth-voice";
