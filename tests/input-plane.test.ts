/**
 * 输入事件面：声明式事件表 → 采样网格上的快照。
 * 覆盖三件事：
 * 1. 快照语义（含边界、同刻顺序、多按钮/多键）
 * 2. 引擎集成（快照与轨道查询一致、同帧共享、两次渲染同序）
 * 3. 组合根装配（RenderOptions.input 真能到达回调）
 */
import { describe, expect, it } from "vitest";
import {
  TimelineEngine,
  createInputTrack,
  render,
  start,
} from "@lingfan-video/core";
import type {
  InputEvent,
  InputSnapshot,
  PointerButton,
  RenderError,
} from "@lingfan-video/contracts";
import { FrameSequenceExporter, MemoryFrameSink } from "@lingfan-video/infra";

const FPS = 30;

function makeEngine(input?: readonly InputEvent[]) {
  const engine = new TimelineEngine({
    fps: FPS,
    width: 4,
    height: 4,
    canvas: { width: 1, height: 1 } as unknown as OffscreenCanvas,
    headless: true,
    input,
  });
  engine.setPainter(() => ({
    data: new Uint8ClampedArray(4 * 4 * 4),
    width: 4,
    height: 4,
  }));
  return engine;
}

/** 捕获回调里拿到的快照（附带时刻，便于和轨道查询对齐） */
function captureScene(out: Array<{ t: number; snap: InputSnapshot }>) {
  return start(200, (env) => {
    env.step(200, (ctx) => {
      out.push({ t: ctx.t, snap: ctx.input });
    });
  });
}

const EVENTS: readonly InputEvent[] = [
  { atMs: 120, kind: "pointer", type: "down", x: 0.2, y: 0.4 },
  { atMs: 0, kind: "key", type: "down", key: "Shift" },
  { atMs: 60, kind: "pointer", type: "move", x: 0.5, y: 0.5 },
  { atMs: 120, kind: "pointer", type: "move", x: 0.25, y: 0.45 },
  { atMs: 150, kind: "pointer", type: "up", x: 0.25, y: 0.45 },
  { atMs: 150, kind: "key", type: "up", key: "Shift" },
];

function errorOf(fn: () => unknown): RenderError {
  try {
    fn();
  } catch (e) {
    return e as RenderError;
  }
  throw new Error("期望抛错，实际没有");
}

describe("输入快照", () => {
  it("无事件时为默认快照：原点未按下、无按键", () => {
    const track = createInputTrack(undefined);
    expect(track.events).toHaveLength(0);
    expect(track.snapshotAt(500)).toEqual({
      pointer: { x: 0, y: 0, down: false },
      buttons: [],
      keys: new Set<string>(),
      lastEventAtMs: null,
    });
  });

  it("归一化按 atMs 排序，同刻保留声明顺序", () => {
    const track = createInputTrack(EVENTS);
    expect(track.events.map((e) => e.atMs)).toEqual([
      0, 60, 120, 120, 150, 150,
    ]);
    // 同刻 down 在 move 之前（声明顺序）→ 该刻快照坐标为 down 的坐标
    expect(track.snapshotAt(120).pointer).toEqual({
      x: 0.25,
      y: 0.45,
      down: true,
    });
  });

  it("边界：atMs == t 的事件已生效，atMs > t 的不生效", () => {
    const track = createInputTrack(EVENTS);
    expect(track.snapshotAt(119.999).pointer.down).toBe(false);
    expect(track.snapshotAt(119.999).lastEventAtMs).toBe(60);
    expect(track.snapshotAt(120).pointer.down).toBe(true);
    expect(track.snapshotAt(120).lastEventAtMs).toBe(120);
    expect(track.snapshotAt(150).pointer.down).toBe(false);
    expect(track.snapshotAt(150).keys.has("Shift")).toBe(false);
  });

  it("多按钮按按下顺序累积，抬起只移除对应按钮", () => {
    const track = createInputTrack([
      {
        atMs: 10,
        kind: "pointer",
        type: "down",
        x: 0.1,
        y: 0.1,
        button: "secondary",
      },
      {
        atMs: 20,
        kind: "pointer",
        type: "down",
        x: 0.2,
        y: 0.2,
        button: "primary",
      },
      {
        atMs: 30,
        kind: "pointer",
        type: "up",
        x: 0.2,
        y: 0.2,
        button: "secondary",
      },
      { atMs: 40, kind: "pointer", type: "up", x: 0.2, y: 0.2 },
    ]);
    expect(track.snapshotAt(20).buttons).toEqual(["secondary", "primary"]);
    expect(track.snapshotAt(30).buttons).toEqual(["primary"]);
    expect(track.snapshotAt(30).pointer.down).toBe(true);
    expect(track.snapshotAt(40).buttons).toEqual([]);
    expect(track.snapshotAt(40).pointer.down).toBe(false);
  });

  it("按键集合按 down/up 增删，重复事件不改变集合", () => {
    const track = createInputTrack([
      { atMs: 10, kind: "key", type: "down", key: "a" },
      { atMs: 20, kind: "key", type: "down", key: "a", repeat: true },
      { atMs: 30, kind: "key", type: "down", key: "ArrowLeft" },
      { atMs: 40, kind: "key", type: "up", key: "a" },
    ]);
    expect([...track.snapshotAt(10).keys]).toEqual(["a"]);
    expect([...track.snapshotAt(20).keys]).toEqual(["a"]);
    expect([...track.snapshotAt(30).keys]).toEqual(["a", "ArrowLeft"]);
    expect([...track.snapshotAt(40).keys]).toEqual(["ArrowLeft"]);
  });

  it("非法事件表在构建期报 spec_violation 并指出第几条", () => {
    const bad: Array<[InputEvent[], RegExp]> = [
      [[{ atMs: -1, kind: "key", type: "down", key: "a" }], /atMs/],
      [[{ atMs: Number.NaN, kind: "key", type: "down", key: "a" }], /atMs/],
      [
        [
          {
            atMs: 0,
            kind: "pointer",
            type: "move",
            x: 0,
            y: Number.POSITIVE_INFINITY,
          },
        ],
        /坐标/,
      ],
      [[{ atMs: 0, kind: "key", type: "down", key: "" }], /key/],
      [
        [
          { atMs: 0, kind: "key", type: "down", key: "a" },
          // 故意越界：运行期校验负责拦住，类型层用断言绕开
          {
            atMs: 5,
            kind: "pointer",
            type: "down",
            x: 0,
            y: 0,
            button: "back" as unknown as PointerButton,
          },
        ],
        /第 1 条/,
      ],
    ];
    for (const [events, message] of bad) {
      const err = errorOf(() => createInputTrack(events));
      expect(err.kind).toBe("spec_violation");
      expect(err.message).toMatch(message);
    }
  });
});

describe("引擎集成", () => {
  it("回调拿到的快照等于轨道在同一时刻的查询，且同帧单元共享同一份", async () => {
    const main: Array<{ t: number; snap: InputSnapshot }> = [];
    const other: InputSnapshot[] = [];
    const scene = start(200, (env) => {
      // 并行分支同一时刻产帧：验证同帧单元共享同一份快照
      env.par([
        (branch) =>
          branch.step(200, (ctx) => {
            main.push({ t: ctx.t, snap: ctx.input });
          }),
        (branch) =>
          branch.step(200, (ctx) => {
            other.push(ctx.input);
          }),
      ]);
    });
    await makeEngine(EVENTS).run(scene, new MemoryFrameSink());

    const track = createInputTrack(EVENTS);
    expect(main.length).toBeGreaterThan(0);
    expect(other).toHaveLength(main.length);
    main.forEach(({ t, snap }, i) => {
      const expected = track.snapshotAt(t);
      expect(snap.pointer).toEqual(expected.pointer);
      expect(snap.buttons).toEqual(expected.buttons);
      expect([...snap.keys]).toEqual([...expected.keys]);
      expect(snap.lastEventAtMs).toBe(expected.lastEventAtMs);
      // 同帧两个单元拿到的是同一个对象（一帧只求值一次快照）
      expect(other[i]).toBe(snap);
    });
  });

  it("同一份事件表两次渲染得到同一串快照；不给输入则是默认快照", async () => {
    const first: Array<{ t: number; snap: InputSnapshot }> = [];
    const second: Array<{ t: number; snap: InputSnapshot }> = [];
    await makeEngine(EVENTS).run(captureScene(first), new MemoryFrameSink());
    await makeEngine(EVENTS).run(captureScene(second), new MemoryFrameSink());
    expect(first.map((x) => x.snap)).toEqual(second.map((x) => x.snap));
    expect(first.some((x) => x.snap.pointer.down)).toBe(true);
    expect(first.some((x) => x.snap.lastEventAtMs === 0)).toBe(true);

    const bare: Array<{ t: number; snap: InputSnapshot }> = [];
    await makeEngine().run(captureScene(bare), new MemoryFrameSink());
    expect(bare.every((x) => x.snap.lastEventAtMs === null)).toBe(true);
    expect(bare.every((x) => x.snap.pointer.down === false)).toBe(true);
  });
});

describe("组合根装配", () => {
  it("RenderOptions.input 经 assemble 到达回调（导出路径真实跑通）", async () => {
    const seen: InputSnapshot[] = [];
    const scene = start(200, (env) => {
      env.step(200, (ctx) => {
        seen.push(ctx.input);
      });
    });
    const exporter = new FrameSequenceExporter();
    await render(scene, {
      fps: 10,
      width: 4,
      height: 4,
      headless: true,
      input: [
        { atMs: 0, kind: "key", type: "down", key: " " },
        { atMs: 50, kind: "pointer", type: "down", x: 0.9, y: 0.1 },
      ],
      painter: () => ({
        data: new Uint8ClampedArray(4 * 4 * 4),
        width: 4,
        height: 4,
      }),
      exporter,
    });
    expect(seen.length).toBe(2); // 200ms @10fps → 采样点 0/100
    expect(seen[0]!.keys.has(" ")).toBe(true);
    expect(seen[0]!.pointer.down).toBe(false);
    expect(seen[1]!.pointer.down).toBe(true);
    expect(seen[1]!.pointer.x).toBe(0.9);
  });
});
