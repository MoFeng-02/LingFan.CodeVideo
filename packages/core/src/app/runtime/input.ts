import type {
  InputEvent,
  InputSnapshot,
  InputTrack,
  Ms,
  PointerButton,
} from "@lingfan-video/contracts";
import { makeRenderError } from "./error";

const BUTTONS: readonly PointerButton[] = ["primary", "secondary", "auxiliary"];

const ZERO = { x: 0, y: 0 } as const;

/** 空快照：尚无生效事件时的初值（指针在原点未按下、无按键） */
export const EMPTY_INPUT: InputSnapshot = {
  pointer: { ...ZERO, down: false },
  buttons: [],
  keys: new Set<string>(),
  lastEventAtMs: null,
};

function isPointerButton(v: unknown): v is PointerButton {
  return typeof v === "string" && (BUTTONS as readonly string[]).includes(v);
}

/** 单条事件校验：返回人读的错误描述，合法返回 null（纯检查） */
function eventError(e: InputEvent, index: number): string | null {
  if (typeof e !== "object" || e === null)
    return `第 ${index} 条输入事件不是对象`;
  if (!Number.isFinite(e.atMs) || e.atMs < 0)
    return `第 ${index} 条输入事件的 atMs 必须是 >= 0 的有限毫秒数`;
  if (e.kind === "pointer") {
    if (e.type !== "down" && e.type !== "move" && e.type !== "up")
      return `第 ${index} 条指针事件的 type 必须是 down/move/up`;
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y))
      return `第 ${index} 条指针事件的坐标必须是有限数`;
    if (e.button !== undefined && !isPointerButton(e.button))
      return `第 ${index} 条指针事件的 button 必须是 primary/secondary/auxiliary`;
    return null;
  }
  if (e.kind === "key") {
    if (e.type !== "down" && e.type !== "up")
      return `第 ${index} 条键盘事件的 type 必须是 down/up`;
    if (typeof e.key !== "string" || e.key.length === 0)
      return `第 ${index} 条键盘事件的 key 必须是非空字符串`;
    if (e.repeat !== undefined && typeof e.repeat !== "boolean")
      return `第 ${index} 条键盘事件的 repeat 必须是布尔值`;
    return null;
  }
  return `第 ${index} 条输入事件的 kind 必须是 pointer/key`;
}

/** 归一化：稳定排序（同刻按声明顺序），不修改入参 */
function normalize(events: readonly InputEvent[]): readonly InputEvent[] {
  if (!Array.isArray(events))
    throw makeRenderError(
      "spec_violation",
      "input",
      0,
      "RenderOptions.input 必须是输入事件数组",
    );
  events.forEach((e, i) => {
    const message = eventError(e, i);
    if (message) throw makeRenderError("spec_violation", "input", 0, message);
  });
  // Array.prototype.sort 稳定：同 atMs 保留声明顺序
  return [...events].sort((a, b) => a.atMs - b.atMs);
}

/** 快照求值：折叠 atMs ≤ t 的事件（含等于），累积指针/按键状态 */
function snapshotAt(list: readonly InputEvent[], t: Ms): InputSnapshot {
  const pointer = { x: 0, y: 0, down: false };
  const buttons: PointerButton[] = [];
  const keys = new Set<string>();
  let lastEventAtMs: Ms | null = null;
  for (const e of list) {
    if (e.atMs > t) break;
    lastEventAtMs = e.atMs;
    if (e.kind === "pointer") {
      pointer.x = e.x;
      pointer.y = e.y;
      const button = e.button ?? "primary";
      if (e.type === "down" && !buttons.includes(button)) buttons.push(button);
      if (e.type === "up") {
        const at = buttons.indexOf(button);
        if (at >= 0) buttons.splice(at, 1);
      }
      pointer.down = buttons.length > 0;
    } else if (e.type === "down") keys.add(e.key);
    else keys.delete(e.key);
  }
  return { pointer, buttons: [...buttons], keys, lastEventAtMs };
}

/**
 * 输入轨道工厂：校验 + 归一化 + 快照查询。
 * 输入是声明式数据而非实时事件——预览与导出注入同一份事件表，快照序列因此一致。
 */
export function createInputTrack(
  events: readonly InputEvent[] | undefined,
): InputTrack {
  const list = normalize(events ?? []);
  return { events: list, snapshotAt: (t) => snapshotAt(list, t) };
}
