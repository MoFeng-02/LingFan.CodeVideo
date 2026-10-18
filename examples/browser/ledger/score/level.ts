/** 动态：起静、中稳、高潮、尾收。按「第几章 + 这一段有多重」给，不查全片时刻。 */
export const levelOfChapter = (chapter: number, accent = false): number => {
  const base = [0.3, 0.52, 0.82][chapter] ?? 0.6;
  return Math.min(1, base + (accent ? 0.12 : 0));
};

export const beatPhase = (t: number): number => {
  const beat = 500;
  return (t % beat) / beat;
};

export const barIndex = (ms: number): number => Math.floor(ms / 2_000);
