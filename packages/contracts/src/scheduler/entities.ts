import type { Ms } from "../shared/units";

/**
 * 消杀选项。
 * fadeOut = 消亡窗口（时间线毫秒）：窗口内目标**继续逐帧求值**，
 * 回调拿 `disposing=true` / `disposeProgress` 0→1 自己画消失过程；
 * 窗口结束才真正出池。缺省 = 立即死（下一帧不再求值）。
 */
export interface KillOptions {
  /** 消亡窗口时长（毫秒，> 0）；缺省 = 立即出池 */
  fadeOut?: Ms;
}

/** spawn 句柄：运行期生命周期控制 */
export interface Handle {
  /**
   * 请求消亡。
   * @param options 缺省立即出池；给 fadeOut 则进入消亡窗口
   */
  kill(options?: KillOptions): void;
  /**
   * 显式持有终结；与 kill() 同义。
   * @param options 缺省立即出池；给 fadeOut 则进入消亡窗口
   */
  dispose(options?: KillOptions): void;
  /** 是否仍在池中；消亡窗口内仍为 true */
  readonly alive: boolean;
  /** 实例本地时间（毫秒）：从 spawn 起算 */
  readonly localTime: Ms;
  /** 实例时长（毫秒）；forever 时为总时间线剩余 */
  readonly duration: Ms;
}

/** 调度器门面：kill 接受句柄或 key/id */
export interface Scheduler {
  /**
   * 按句柄或名字杀死目标。
   * @param handleOrKey spawn 句柄，或 spawn 链的 key、step/loop 单元的 id
   * @param options 缺省立即出池；给 fadeOut 则进入消亡窗口
   */
  kill(handleOrKey: Handle | string, options?: KillOptions): void;
  /**
   * 杀死全部活跃单元（含 spawn 实例）。
   * @param options 缺省立即出池；给 fadeOut 则全部进入同一消亡窗口
   */
  killAll(options?: KillOptions): void;
  /** 当前存活单元数（含消亡窗口内的实例） */
  readonly alive: number;
}

/** spawn 选项：key 必填（同 key 去重 = 跨段续接） */
export interface SpawnOptions {
  /** 实例键：同 key 再次 spawn 即续接同一实例，而不是新建 */
  key: string;
  /** 相对登记位置的起播偏移（毫秒）；缺省 = 登记处 */
  at?: Ms;
  /** 实例时长（毫秒）；缺省 = 场景自身时长 */
  duration?: Ms;
  /** forever：寿命 = 总时间线尾或显式 kill()，时钟由全局时间线推导 */
  forever?: boolean;
  /** 整条链的基础采样密度（链内单元未声明 fps 时继承；缺省 = 引擎基础帧率） */
  fps?: number;
}
