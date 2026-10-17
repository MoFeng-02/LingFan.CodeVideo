import type { Ms } from "@lingfan-video/contracts";
import type { SceneInternal, SimNode } from "./types";
import type {
  CompiledAudio,
  CompiledSegment,
  CompiledSpawn,
  CompiledUnit,
} from "./types";

/**
 * 单段编译：把登记流（Recorder.nodes）展平为绝对时间单元。
 * 规则：
 * - cursor 只被 step/wait/par 推进；loop 窗口 = min(ms×times, 段尾-起点)
 * - step.at 为窗外绝对偏移（越窗 → window_overflow 由 validate/render 报）
 * - spawn 锚点 = 登记 cursor + options.at
 * - transitionTo = 提前收窗：anchor 之后的本段节点不活跃
 */
export function compileSegment(
  sceneId: string,
  duration: Ms,
  nodes: SimNode[],
  bodyResult: unknown,
): CompiledSegment {
  const units: CompiledUnit[] = [];
  const spawns: CompiledSpawn[] = [];
  const audio: CompiledAudio[] = [];
  let activeEnd: Ms | undefined;
  let transitionNext: unknown;
  let order = 0;

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
            call: n.fn as CompiledUnit["call"],
            order: order++,
          });
          local += n.duration;
          break;
        }
        case "wait": {
          local += n.duration;
          break;
        }
        case "loop": {
          const iterMs = n.ms;
          if (iterMs === undefined) {
            // form-3：自管节奏，整段活跃，由 runtime 以 ctx.next()/stop() 驱动
            units.push({
              key: `loop#form3#${order}`,
              windowStart: local,
              windowEnd: duration,
              hold: false,
              call: n.fn as CompiledUnit["call"],
              loop: { iteration: 0 },
              loopBase: `loop#form3#${order}`,
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
                call: n.fn as CompiledUnit["call"],
                loop: { iteration: it, iterationMs: iterMs },
                loopBase: `loop#${order}`,
                order,
              });
            }
            local += window;
            order++;
          }
          break;
        }
        case "par": {
          // 分支共享起点各自推进；本层推进 = max(分支池)
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
          });
          break;
        }
        case "transition": {
          activeEnd = local;
          transitionNext = n.next;
          break;
        }
        case "audio": {
          const o = n.options;
          audio.push({
            clipUrl: n.clipUrl,
            atMs: local + (o.at ?? 0),
            volume: o.volume ?? 1,
            fadeIn: o.fadeIn,
            fadeOut: o.fadeOut,
            loop: o.loop ?? false,
          });
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
    activeEnd,
    transitionNext,
    bodyResult,
  };
}
