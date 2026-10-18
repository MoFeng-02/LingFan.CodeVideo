import type { Ms } from "../shared/units";
import type { InputEvent, InputSnapshot } from "./entities";

/**
 * 输入轨道：把一份声明式事件表变成「某时刻的快照查询」。
 * 只读、无副作用——同一时刻多次查询得同一份快照；实现由组合根提供，
 * 预览与导出注入同一份事件表即可得到同一串快照。
 */
export interface InputTrack {
  readonly events: readonly InputEvent[];
  snapshotAt(t: Ms): InputSnapshot;
}
