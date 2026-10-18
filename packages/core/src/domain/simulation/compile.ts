/**
 * 单段编译：把登记期节点流展平成以毫秒计的编译产物。
 *
 * 这是「登记（相对游标）」到「运行（绝对时刻）」的唯一转换点：本文件不做平台调用，
 * 只做纯计算，因此同一份编译产物可被校验、预览、出片共用。展平后每个单元都带
 * 段内绝对窗口与已解析的采样密度，运行期不再回溯节点树。
 *
 * 关键约定：`cursor` 只被 `step`/`wait`/`par` 推进；`loop`/`spawn`/`audio`/`layer` 等
 * 记锚点但不推进。帧窗池由本文件按 `min` / `max` 规则夹取，长度不会超过段窗口。
 */
import type {
  BusAutomationSpec,
  BusSpec,
  DuckRule,
  Ms,
  SendSpec,
} from "@lingfan-video/contracts";
import { synthVoiceOptions } from "../audio/synth-voice";
import { SYNTH_CLIP } from "../audio/synth-clip";
import { violation } from "../spec-violation";
import type { SceneInternal, SimNode } from "./types";
import type {
  CompiledAudio,
  CompiledLayer,
  CompiledSegment,
  CompiledSpawn,
  CompiledUnit,
} from "./types";

/** wait 单元的 call 占位（wait 不发布 FrameState，回调走 onUpdate） */
const NOOP: CompiledUnit["call"] = () => {};

/**
 * 单段编译：把登记流（`Recorder.nodes`）展平为段内绝对时间的单元、音频与层声明。
 *
 * 规则：
 * - `cursor` 只被 `step`/`wait`/`par` 推进；`loop` 窗口 = `min(ms×times, 段尾-起点)`
 * - `step.at` 为相对登记位置的偏移（可为负；越窗由校验报 `window_overflow`）
 * - `spawn` 锚点 = 登记 `cursor` + `options.at`，链时长顺 `next` 累加
 * - `transitionTo` = 提前收窗：`anchor` 之后的本段节点不再活跃（遇到即停）
 * - 单元有效帧率 = 单元声明 > 继承（spawn 链级）> 基础；编译期解析定死
 *
 * @param sceneId 段标识（诊断与聚合键用；只透传进产物，不参与计算）
 * @param duration 段窗口长度（毫秒）：所有单元窗口的上界
 * @param nodes 登记期节点流（按登记顺序；本函数不修改它）
 * @param bodyResult 本段 body 的返回值，成为链上下一幕 body 的 prev
 * @param baseFps 引擎基础采样密度（帧/秒）：单元/链都未声明时用它
 * @param inheritedFps 外层继承的采样密度（帧/秒，如 spawn 链级）；undefined = 用 baseFps
 * @returns 单段编译结果（单元含绝对窗口、音频/层含段内相对锚点）
 * @throws spec_violation 过场重叠窗吃满整段时（没有可重叠的收窗长度）
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
  const automations: BusAutomationSpec[] = [];
  const layers: CompiledLayer[] = [];
  let activeEnd: Ms | undefined;
  let transitionNext: unknown;
  let transitionOverlap: Ms | undefined;
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
            // 未给 ms：自管节奏，整段活跃，由 runtime 以 ctx.next()/stop() 驱动
            units.push({
              key: `loop#self#${order}`,
              windowStart: local,
              windowEnd: duration,
              hold: false,
              fps: loopFps,
              call: n.fn as CompiledUnit["call"],
              loop: { iteration: 0 },
              loopBase: `loop#self#${order}`,
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
            // 重复是后台并行的：不推进 cursor，后续节点仍从 local 起
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
          transitionOverlap = n.overlapMs;
          if (transitionOverlap !== undefined && transitionOverlap >= local)
            throw violation(
              `${sceneId} 的 transitionTo 重叠窗 ${transitionOverlap}ms 不能吃满整段（本段收窗长度 ${local}ms）`,
            );
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
        case "synth": {
          // 程序化音源：锚点 = 登记位置（不叠加 at，synth 无 at 选项）
          audio.push({
            clip: SYNTH_CLIP,
            atMs: local,
            options: synthVoiceOptions(n.spec),
            synth: n.spec,
          });
          break;
        }
        case "automate": {
          // 段内相对时刻；全局化（含循环圈平移）由 runtime 在时间线构建时完成
          automations.push(n.spec);
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
        case "layer": {
          // 段内相对锚点：登记位置 + declaration.from；终点给了 to 才记（否则本段收窗）
          layers.push({
            declaration: n.declaration,
            fromMs: n.anchor + (n.declaration.from ?? 0),
            ...(n.declaration.to === undefined
              ? {}
              : { toMs: n.anchor + n.declaration.to }),
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
    buses,
    sends,
    ducks,
    automations,
    layers,
    activeEnd,
    transitionNext,
    transitionOverlap,
    bodyResult,
  };
}
