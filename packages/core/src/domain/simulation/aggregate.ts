/**
 * 帧状态的 key 化聚合：把同帧多个单元的发布合并成一份帧状态。
 *
 * 聚合键是「段标识/单元键」，不是全局表：并行分支的兄弟单元各有自己的键，
 * 因此不会互相覆盖（禁止全局 last-write-wins）。同帧同键后写覆盖，异键并存。
 * `hold` 是参数冻结糖：单元窗外不再发布，但聚合表继续沿用上一帧该键的条目。
 * 每次取帧都从「本帧活跃集合」导出，沉寂的键（如已退场的嵌入链）自然退出帧状态。
 */
import type { FrameState } from "@lingfan-video/contracts";

/**
 * key 化状态聚合：
 * - 发布主体 = 逐帧 fn 返回的 FrameState；按 fn 归属 key 聚合，禁止全局 last-write-wins（par 兄弟互踩）
 * - 同帧多发布：同 key 后写覆盖（同节点内确定性），异 key 并存
 * - hold：参数冻结糖——聚合表沿用上一帧该 key 的条目（fn 每帧照调）
 */
export class StateAggregator {
  /** 全部键 → 最近一次发布的状态（跨帧保留，直到被覆盖或清理） */
  private readonly entries = new Map<string, unknown>();
  /** 本帧活跃键集合：每帧结束时由 snapshot 导出并清空 */
  private readonly touched = new Set<string>();

  /**
   * 发布一个单元的本帧状态（同帧同键后写覆盖）。
   *
   * @param key 聚合键，形如 `段标识/单元键`（跨段防互踩）
   * @param state 该单元本帧的状态对象
   */
  publish(key: string, state: FrameState): void {
    this.entries.set(key, state);
    this.touched.add(key);
  }

  /**
   * hold 单元：本帧不发布也保留上一帧值，并把该键记为活跃。
   *
   * 首次触达且没有历史值时先放一个空对象，保证键在帧状态里存在。
   *
   * @param key 聚合键，形如 `段标识/单元键`
   */
  touchHold(key: string): void {
    if (!this.entries.has(key)) this.entries.set(key, {});
    this.touched.add(key);
  }

  /**
   * 帧终聚合：只导出本帧活跃的键，并清空活跃集合（下一帧重新累积）。
   *
   * 因此未在本帧触达的键（如已退场的嵌入链）会自然从帧状态里消失。
   *
   * @returns 本帧的帧状态（活跃键 → 最新状态）
   */
  snapshot(): FrameState {
    const out: FrameState = {};
    for (const key of this.touched) {
      const v = this.entries.get(key);
      if (v !== undefined) out[key] = v;
    }
    this.touched.clear();
    return out;
  }

  /**
   * 完整状态表：包含未在本帧触达的条目（供按时刻取值的计算用）。
   *
   * @returns 全部键 → 最近一次发布的状态（拷贝，不是内部表）
   */
  full(): FrameState {
    return Object.fromEntries(this.entries);
  }

  /** 清空全部键与活跃集合（引擎重入时防串台） */
  clear(): void {
    this.entries.clear();
    this.touched.clear();
  }
}
