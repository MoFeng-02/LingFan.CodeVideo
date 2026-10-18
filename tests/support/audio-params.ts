/**
 * AudioParam 的测试替身与求值：预览端把参数写成自动化事件，这里负责记录并按
 * WebAudio 语义求值，供与导出端的逐样本结果比对。
 *
 * 语义与 WebAudio 一致：`setValueAtTime` 把值保持到下一个事件；`linearRampToValueAtTime`
 * 与上一个事件之间线性插值；`.value` 直接赋值即时生效、不产生自动化事件。
 */

export interface ParamEvent {
  readonly value: number;
  readonly at: number;
  readonly ramp: boolean;
}

export interface ParamLike {
  value: number;
  setValueAtTime(value: number, at: number): void;
  linearRampToValueAtTime(value: number, at: number): void;
  cancelScheduledValues(at?: number): void;
}

/** AudioParam 语义替身 */
export function makeParam(
  events: ParamEvent[],
  rec: { value: number },
): ParamLike {
  return {
    get value() {
      return rec.value;
    },
    set value(v: number) {
      rec.value = v;
    },
    setValueAtTime(value: number, at: number) {
      rec.value = value;
      events.push({ value, at, ramp: false });
    },
    linearRampToValueAtTime(value: number, at: number) {
      rec.value = value;
      events.push({ value, at, ramp: true });
    },
    cancelScheduledValues() {},
  };
}

/** 按事件表求 `sec` 时刻的参数有效值 */
export function paramAt(events: readonly ParamEvent[], sec: number): number {
  let anchorAt = Number.NEGATIVE_INFINITY;
  let anchorValue = 1;
  for (const e of events) {
    if (e.at > sec) {
      if (e.ramp && Number.isFinite(anchorAt) && e.at > anchorAt) {
        const k = (sec - anchorAt) / (e.at - anchorAt);
        return anchorValue + (e.value - anchorValue) * k;
      }
      return anchorValue;
    }
    anchorAt = e.at;
    anchorValue = e.value;
  }
  return anchorValue;
}
