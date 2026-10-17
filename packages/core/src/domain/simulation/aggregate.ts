import type { FrameState } from "@lingfan-video/contracts";

/**
 * key 化状态聚合：
 * - 发布主体 = 逐帧 fn 返回的 FrameState；按 fn 归属 key 聚合，禁止全局 last-write-wins（par 兄弟互踩）
 * - 同帧多发布：同 key 后写覆盖（同节点内确定性），异 key 并存
 * - hold：参数冻结糖——聚合表沿用上一帧该 key 的条目（fn 每帧照调）
 */
export class StateAggregator {
  private readonly entries = new Map<string, unknown>();
  /** 本帧活跃 key 集合（由 runtime 每帧重建） */
  private readonly touched = new Set<string>();

  publish(key: string, state: FrameState): void {
    this.entries.set(key, state);
    this.touched.add(key);
  }

  /** hold 节点：不发布也保留上一帧值（首次无值则为空对象） */
  touchHold(key: string): void {
    if (!this.entries.has(key)) this.entries.set(key, {});
    this.touched.add(key);
  }

  /** 帧终聚合：只导出本帧活跃 key（非活跃 spawn 链自然退场） */
  snapshot(): FrameState {
    const out: FrameState = {};
    for (const key of this.touched) {
      const v = this.entries.get(key);
      if (v !== undefined) out[key] = v;
    }
    this.touched.clear();
    return out;
  }

  /** computeAt 用：完整状态表（含未在本帧触达的条目） */
  full(): FrameState {
    return Object.fromEntries(this.entries);
  }

  /** 重置（引擎重入防串台；聚合键 = `${sceneId}/${unitKey}`，跨段防互踩） */
  clear(): void {
    this.entries.clear();
    this.touched.clear();
  }
}
