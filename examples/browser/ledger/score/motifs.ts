/** 音高与重音的设计数据：印章音阶、和弦、低频根音、重击力度。 */
export const STAMP_PITCHES = [
  220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25, 783.99, 880,
  1_046.5,
];

/** 垫底和弦：A 自然小调的六个级和弦，两小节换一次，低频不挤在一起。 */
export const PAD_CHORDS: ReadonlyArray<readonly number[]> = [
  [110, 130.81, 164.81], // Am
  [130.81, 164.81, 196], // C
  [146.83, 174.61, 220], // Dm
  [164.81, 196, 246.94], // Em
  [174.61, 220, 261.63], // F
  [196, 246.94, 293.66], // G
];

export const DRONE_ROOTS = [55, 41, 49] as const;

export const ACCENT_POWER: Record<string, number> = {
  K07: 0.9,
  K22: 0.85,
  K23: 1,
};

/** 非重击切点只留一声很轻的 ping：标出刀口，不砸。 */
export const PING_CUTS: Record<string, readonly [number, number]> = {
  K05: [0.12, 880],
  K06: [0.13, 987.77],
  K09: [0.14, 1_046.5],
  K12: [0.15, 1_174.66],
  K15: [0.14, 1_318.51],
  K18: [0.16, 880],
  K20: [0.13, 1_046.5],
  K30: [0.18, 1_567.98],
};

export const NOISE_SWEEPS: ReadonlyArray<readonly [number, number, number]> = [
  [34_000, 0.24, 320],
  [36_500, 0.28, 480],
  [39_000, 0.3, 640],
  [57_000, 0.22, 800],
  [58_200, 0.26, 1_100],
  [59_400, 0.3, 1_400],
];

export const CLOSE_NOTES: ReadonlyArray<readonly [number, number]> = [
  [110, 0.6],
  [164.81, 0.55],
  [220, 0.5],
];
