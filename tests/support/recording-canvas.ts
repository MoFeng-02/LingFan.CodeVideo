/**
 * 记录型假画布：不产生像素，只把 2D 调用流折进一个滚动哈希。
 *
 * 用途：把「这部片子」当测试素材——在 node 里跑完 1300 多帧，
 * 逐帧拿到一个调用流指纹，于是可以断言"同一剧本两遍推演出同一串指纹"。
 * 它检验的不是光栅结果，而是**绘制输入的确定性**：
 * 只要剧本里混进 Math.random、Date.now 或与调用顺序相关的隐式状态，指纹立刻分叉。
 */
import type { FrameBitmap } from "@lingfan-video/contracts";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 每帧一个指纹；`take()` 取走后复位，下一帧重新累计。 */
export interface RecordingCanvas {
  /** 交给 RenderOptions.canvas 用（类型上是 DOM 画布，实际是替身） */
  readonly canvas: HTMLCanvasElement;
  /** 取走自上次 `take()` 以来的调用流指纹 */
  take(): string;
  /** 已记录的 2D 调用总数（用于断言"真的画了东西"） */
  calls(): number;
}

export function makeRecordingCanvas(
  width: number,
  height: number,
): RecordingCanvas {
  let h = FNV_OFFSET;
  let calls = 0;

  const mix = (word: number): void => {
    h = Math.imul(h ^ (word & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((word >>> 8) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((word >>> 16) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((word >>> 24) & 0xff), FNV_PRIME);
  };
  const mixText = (s: string): void => {
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
    mix(0xffff);
  };
  const mixNumber = (n: number): void => {
    // 整数部分与千分之一小数部分分开混合：既能区分 0.001，也不会在乘积上溢出。
    mix(Math.trunc(n) | 0);
    mix(Math.round((n - Math.trunc(n)) * 1000) | 0);
  };
  const mixArg = (v: unknown): void => {
    if (typeof v === "number") {
      mix(0x11);
      mixNumber(v);
    } else if (typeof v === "string") {
      mix(0x22);
      mixText(v);
    } else if (typeof v === "boolean") {
      mix(0x33);
      mix(v ? 1 : 0);
    } else if (v === null || v === undefined) {
      mix(0x44);
    } else if (Array.isArray(v)) {
      mix(0x55);
      for (const item of v) mixArg(item);
    } else {
      mix(0x66);
      mixText(String((v as { tag?: string }).tag ?? "obj"));
    }
  };

  let gradientSeq = 0;
  const gradient = (): { tag: string; addColorStop: () => void } => {
    const tag = `gradient#${gradientSeq++}`;
    return {
      tag,
      addColorStop: () => {
        mix(0x77);
      },
    };
  };

  const record =
    (name: string, returns?: () => unknown) =>
    (...args: unknown[]): unknown => {
      calls += 1;
      mixText(name);
      for (const a of args) mixArg(a);
      return returns === undefined ? undefined : returns();
    };

  const target: Record<string, unknown> = {
    save: record("save"),
    restore: record("restore"),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    bezierCurveTo: record("bezierCurveTo"),
    quadraticCurveTo: record("quadraticCurveTo"),
    arc: record("arc"),
    arcTo: record("arcTo"),
    ellipse: record("ellipse"),
    rect: record("rect"),
    roundRect: record("roundRect"),
    fill: record("fill"),
    stroke: record("stroke"),
    clip: record("clip"),
    translate: record("translate"),
    scale: record("scale"),
    rotate: record("rotate"),
    transform: record("transform"),
    setTransform: record("setTransform"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    clearRect: record("clearRect"),
    fillText: record("fillText"),
    strokeText: record("strokeText"),
    setLineDash: record("setLineDash"),
    drawImage: record("drawImage"),
    putImageData: record("putImageData"),
    createLinearGradient: record("createLinearGradient", () => gradient()),
    createRadialGradient: record("createRadialGradient", () => gradient()),
    createPattern: record("createPattern", () => gradient()),
    measureText: record("measureText", () => ({ width: 12 }) as TextMetrics),
    getImageData: record("getImageData", () => {
      const data = new Uint8ClampedArray(4);
      return { data, width: 1, height: 1 } as unknown as ImageData;
    }),
    createImageData: record("createImageData", () => {
      const data = new Uint8ClampedArray(4);
      return { data, width: 1, height: 1 } as unknown as ImageData;
    }),
    canvas: null as unknown,
  };

  const ctx = new Proxy(target, {
    get(t, prop: string | symbol) {
      const value = t[prop as string];
      return value;
    },
    set(t, prop: string | symbol, value: unknown) {
      mixText(String(prop));
      mixArg(value);
      t[prop as string] = value;
      return true;
    },
  });

  const fakeCanvas = {
    width,
    height,
    getContext: (kind: string): unknown => {
      mixText(`getContext:${kind}`);
      return ctx;
    },
  };
  target["canvas"] = fakeCanvas;

  return {
    canvas: fakeCanvas as unknown as HTMLCanvasElement,
    take: () => {
      const hex = (h >>> 0).toString(16).padStart(8, "0");
      h = FNV_OFFSET;
      return hex;
    },
    calls: () => calls,
  };
}

/** 全 0 位图（`frames: "allow-blank"` 下引擎给的就是它，这里只做类型占位）。 */
export const blankFrame = (w: number, h: number): FrameBitmap => ({
  data: new Uint8ClampedArray(w * h * 4),
  width: w,
  height: h,
});
