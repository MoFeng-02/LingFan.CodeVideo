/**
 * 确定性随机源：引擎把「随机」当数据，而不是当熵。
 *
 * 同一份剧本 + 同一个种子 + 同一调用序列 = 同一帧序列（导出可复现）；
 * 换种子 = 换一次抽取。每个单元实例拿到一条**独立子流**：
 * 别的单元调用多少次都不改变本单元的序列（新增/删除单元不会让整场重新洗牌）。
 */
export interface RandomStream {
  /** [0,1) 均匀分布 */
  next(): number;
  /**
   * [min,max) 均匀分布的浮点数。
   * @param min 下界（含）
   * @param max 上界（不含，须 > min）
   */
  float(min: number, max: number): number;
  /**
   * [min,max) 均匀分布的整数；要求整数且 max > min。
   * @param min 下界（含）
   * @param max 上界（不含）
   */
  int(min: number, max: number): number;
  /**
   * 以 probability（0..1）的概率为 true。
   * @param probability 命中概率，0..1
   */
  chance(probability: number): boolean;
  /**
   * 从非空数组里均匀取一项。
   * @param items 非空数组
   */
  pick<T>(items: readonly T[]): T;
  /**
   * 派生一条独立子流：同一 label 得到同一序列，且与父流已调用多少次无关。
   * 需要跟别的单元/别的用途互不干扰时用它，而不是共享一条流。
   * @param label 子流标签：同名 = 同一条序列
   */
  fork(label: string): RandomStream;
}

/**
 * 程序缺省随机种子（`RenderOptions.seed` 缺省值）。
 * 取值只需稳定：既有剧本不使用 `ctx.random`，故缺省种子不影响任何历史输出。
 */
export const DEFAULT_PROGRAM_SEED = 1;
