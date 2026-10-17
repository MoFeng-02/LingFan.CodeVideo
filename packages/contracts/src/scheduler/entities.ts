import type { Ms } from "../shared/units";

/** spawn 句柄：运行期生命周期控制 */
export interface Handle {
  kill(): void;
  /** 显式持有终结；与 kill() 同义 */
  dispose(): void;
  readonly alive: boolean;
  readonly localTime: Ms;
  readonly duration: Ms;
}

/** 调度器门面：kill 接受句柄或 key */
export interface Scheduler {
  kill(handleOrKey: Handle | string): void;
  killAll(): void;
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
