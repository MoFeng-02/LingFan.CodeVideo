/** 网格：响动一律落在 100ms 网格上。 */
export const GRID = 100;

/** 力度保留两位：同一份剧本必得同一份声音 */
export function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
