import type { BusSpec, DuckRule, Ms, SendSpec } from "@lingfan-video/contracts";
import type { SceneInternal, SimNode } from "./types";
import type {
  CompiledAudio,
  CompiledSegment,
  CompiledSpawn,
  CompiledUnit,
} from "./types";

/** wait 单元的 call 占位（wait 不发布 FrameState，回调走 onUpdate） */
const NOOP: CompiledUnit["call"] = () => {};

/**
 * 单段编译：把登记流（Recorder.nodes）展平为绝对时间单元。
 * 规则：
 * - cursor 只被 step/wait/par 推进；loop 窗口 = min(ms×times, 段尾-起点)
 * - step.at 为窗外绝对偏移（越窗 → window_overflow 由 validate/render 报）
 * - spawn 锚点 = 登记 cursor + options.at
 * - transitionTo = 提前收窗：anchor 之后的本段节点不活跃
 * - 单元有效帧率 = 单元声明 > 继承（spawn 链级）> 基础；编译期解析定死
 */
export function compileSegment(
  sceneId: string,
  duration: Ms,
  nodes: SimNode[],
  bodyResult: unknown,
  baseFps: number,
  inheritedFps?: number,
): CompiledSegment {
  const units: CompiledUnit[] = [];
  const spawns: CompiledSpawn[] = [];
  const audio: CompiledAudio[] = [];
  const buses: BusSpec[] = [];
  const sends: SendSpec[] = [];
  const ducks: DuckRule[] = [];
  let activeEnd: Ms | undefined;
  let transitionNext: unknown;
  let order = 0;
  /** 有效帧率解析：本节点声明优先，否则用外层继承 */
  const effFps = (declared?: number): number =>
    declared ?? inheritedFps ?? baseFps;

  const walk = (list: SimNode[], offset: Ms): Ms => {
    let local: Ms = offset;
    for (const n of list) {
      if (activeEnd !== undefined && local >= activeEnd) break;
      switch (n.kind) {
        case "step": {
          const start = local + (n.at ?? 0);
          units.push({
            key: `step#${order}`,
            windowStart: start,
            windowEnd: start + n.duration,
            hold: n.hold ?? false,
            fps: effFps(n.fps),
            call: n.fn as CompiledUnit["call"],
            disposeId: n.id,
            order: order++,
          });
          local += n.duration;
          break;
        }
        case "wait": {
          if (n.onUpdate) {
            // wait 回调单元：不产帧（采样网格跳过它），只在其他单元产帧的网格点上被调用
            units.push({
              key: `wait#${order}`,
              windowStart: local,
              windowEnd: local + n.duration,
              hold: false,
              fps: effFps(), // 不产帧，仅占位（网格构建时按 onUpdate 跳过）
              call: NOOP,
              onUpdate: n.onUpdate,
              disposeId: n.id,
              order: order++,
            });
          }
          local += n.duration;
          break;
        }
        case "loop": {
          const iterMs = n.ms;
          const loopFps = effFps(n.fps);
          if (iterMs === undefined) {
            // form-3：自管节奏，整段活跃，由 runtime 以 ctx.next()/stop() 驱动
            units.push({
              key: `loop#form3#${order}`,
              windowStart: local,
              windowEnd: duration,
              hold: false,
              fps: loopFps,
              call: n.fn as CompiledUnit["call"],
              loop: { iteration: 0 },
              loopBase: `loop#form3#${order}`,
              disposeId: n.id,
              order: order++,
            });
          } else {
            const times = n.times ?? Infinity;
            const pool = iterMs * times;
            const window = Math.min(pool, duration - local);
            const total = Math.max(1, Math.ceil(window / iterMs));
            for (let it = 0; it < total; it++) {
              const s = local + it * iterMs;
              units.push({
                key: `loop#${order}:${it}`,
                windowStart: s,
                windowEnd: Math.min(s + iterMs, local + window),
                hold: false,
                fps: loopFps,
                call: n.fn as CompiledUnit["call"],
                loop: { iteration: it, iterationMs: iterMs },
                loopBase: `loop#${order}`,
                disposeId: n.id,
                order,
              });
            }
            local += window;
            order++;
          }
          break;
        }
        case "par": {
          // 分支共享起点各自推进；本层推进 = max(分支池)；分支继承同层 fps
          let maxPool: Ms = 0;
          for (const branch of n.children) {
            const branchEnd = walk(branch, local);
            maxPool = Math.max(maxPool, branchEnd - local);
          }
          local += maxPool;
          break;
        }
        case "spawn": {
          const chain = n.scene as unknown as SceneInternal<unknown>;
          let chainDuration: Ms = 0;
          let s: SceneInternal<unknown> | undefined = chain;
          while (s) {
            chainDuration += s.duration;
            s = s.next;
          }
          spawns.push({
            key: n.options.key,
            scene: n.scene,
            startGlobal: local + (n.options.at ?? 0),
            chainDuration,
            forever: n.options.forever ?? false,
            // 链级基础帧率：显式 > 当前继承（链内单元再按自己声明覆盖）
            chainFps: n.options.fps ?? inheritedFps,
          });
          break;
        }
        case "transition": {
          activeEnd = local;
          transitionNext = n.next;
          break;
        }
        case "audio": {
          // 段内绝对锚点 = 登记位置 + at；全局化与循环圈展开由 runtime 承担
          audio.push({
            clip: n.clip,
            atMs: local + (n.options.at ?? 0),
            options: n.options,
          });
          break;
        }
        case "bus": {
          buses.push(n.spec);
          break;
        }
        case "send": {
          sends.push(n.spec);
          break;
        }
        case "duck": {
          ducks.push(n.rule);
          break;
        }
      }
    }
    return local;
  };

  walk(nodes, 0);
  return {
    sceneId,
    duration,
    units,
    spawns,
    audio,
    buses,
    sends,
    ducks,
    activeEnd,
    transitionNext,
    bodyResult,
  };
}
