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
