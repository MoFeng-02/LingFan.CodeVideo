import type { Ms } from "../shared/units";

/**
 * 指针位置：归一化到单位方格（0..1，左上角为原点）。
 * 与分辨率、设备无关——预览与导出读同一份坐标，换分辨率不改变语义。
 */
export interface PointerState {
  readonly x: number;
  readonly y: number;
  readonly down: boolean;
}

export type PointerButton = "primary" | "secondary" | "auxiliary";

/** 指针事件：鼠标 / 触摸 / 笔同一套（设备差异在事件表里归一） */
export interface PointerInputEvent {
  readonly atMs: Ms;
  readonly kind: "pointer";
  readonly type: "down" | "move" | "up";
  readonly x: number;
  readonly y: number;
  /** down/up 的按钮；缺省按 primary 处理 */
  readonly button?: PointerButton;
}

/** 键盘事件：key 取 KeyboardEvent.key 的取值（"a" / "ArrowLeft" / " "） */
export interface KeyInputEvent {
  readonly atMs: Ms;
  readonly kind: "key";
  readonly type: "down" | "up";
  readonly key: string;
  /** 自动重复（长按）为 true：不改变按下集合 */
  readonly repeat?: boolean;
}

export type InputEvent = PointerInputEvent | KeyInputEvent;

/**
 * 某一时刻的输入快照：纯只读数据。
 * 语义 = 该时刻已生效的全部事件累积结果；同输入在任意时刻查询必得相等快照。
 */
export interface InputSnapshot {
  readonly pointer: PointerState;
  /** 当前按下的指针按钮（按下顺序） */
  readonly buttons: readonly PointerButton[];
  /** 当前按下的键集合 */
  readonly keys: ReadonlySet<string>;
  /** 已生效的最后一个事件时刻；尚无生效事件为 null */
  readonly lastEventAtMs: Ms | null;
}
