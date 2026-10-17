import type { Ms } from "../shared/units";

/**
 * 消杀选项。
 * fadeOut = 消亡窗口（时间线毫秒）：窗口内目标**继续逐帧求值**，
 * 回调拿 `disposing=true` / `disposeProgress` 0→1 自己画消失过程；
 * 窗口结束才真正出池。缺省 = 立即死（下一帧不再求值）。
 */
export interface KillOptions {
  fadeOut?: Ms;
}

/** spawn 句柄：运行期生命周期控制 */
export interface Handle {
  kill(options?: KillOptions): void;
  /** 显式持有终结；与 kill() 同义 */
  dispose(options?: KillOptions): void;
  readonly alive: boolean;
  readonly localTime: Ms;
  readonly duration: Ms;
}

/** 调度器门面：kill 接受句柄或 key/id */
export interface Scheduler {
  /** 目标：spawn 链的 key，或 step/loop 单元的 id（编译键兜底） */
  kill(handleOrKey: Handle | string, options?: KillOptions): void;
  killAll(options?: KillOptions): void;
  readonly alive: number;
}

/** spawn 选项：key 必填（同 key 去重 = 跨段续接） */
export interface SpawnOptions {
  key: string;
  at?: Ms;
  duration?: Ms;
  /** forever：寿命 = 总时间线尾或显式 kill()，时钟由全局时间线推导 */
  forever?: boolean;
  /** 整条链的基础采样密度（链内单元未声明 fps 时继承；缺省 = 引擎基础帧率） */
  fps?: number;
}
