import type { Ms } from "../shared/units";

/**
 * 指针位置：归一化到单位方格（0..1，左上角为原点）。
 * 与分辨率、设备无关——预览与导出读同一份坐标，换分辨率不改变语义。
 */
export interface PointerState {
  /** 归一化横坐标（0..1，左 → 右） */
  readonly x: number;
  /** 归一化纵坐标（0..1，上 → 下） */
  readonly y: number;
  /** 主按钮是否按下 */
  readonly down: boolean;
}

/** 指针按钮：主（左键/单指）、次（右键/双指）、辅助（中键、侧键等） */
export type PointerButton = "primary" | "secondary" | "auxiliary";

/** 指针事件：鼠标 / 触摸 / 笔同一套（设备差异在事件表里归一） */
export interface PointerInputEvent {
  /** 事件时刻（时间线毫秒） */
  readonly atMs: Ms;
  /** 事件种类判别符 */
  readonly kind: "pointer";
  /** 按下 / 移动 / 抬起 */
  readonly type: "down" | "move" | "up";
  /** 归一化横坐标（0..1） */
  readonly x: number;
  /** 归一化纵坐标（0..1） */
  readonly y: number;
  /** down/up 的按钮；缺省按 primary 处理 */
  readonly button?: PointerButton;
}

/** 键盘事件：key 取 KeyboardEvent.key 的取值（"a" / "ArrowLeft" / " "） */
export interface KeyInputEvent {
  /** 事件时刻（时间线毫秒） */
  readonly atMs: Ms;
  /** 事件种类判别符 */
  readonly kind: "key";
  /** 按下 / 抬起 */
  readonly type: "down" | "up";
  /** KeyboardEvent.key 的取值 */
  readonly key: string;
  /** 自动重复（长按）为 true：不改变按下集合 */
  readonly repeat?: boolean;
}

/** 声明式输入事件：指针与键盘的判别联合 */
export type InputEvent = PointerInputEvent | KeyInputEvent;

/**
 * 某一时刻的输入快照：纯只读数据。
 * 语义 = 该时刻已生效的全部事件累积结果；同输入在任意时刻查询必得相等快照。
 */
export interface InputSnapshot {
  /** 指针位置与主按钮状态 */
  readonly pointer: PointerState;
  /** 当前按下的指针按钮（按下顺序） */
  readonly buttons: readonly PointerButton[];
  /** 当前按下的键集合 */
  readonly keys: ReadonlySet<string>;
  /** 已生效的最后一个事件时刻；尚无生效事件为 null */
  readonly lastEventAtMs: Ms | null;
}
