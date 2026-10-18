/**
 * 段编译的最小面：body 捕获节点流 → 编译产物。
 * 供主链构建（timeline-build）与运行期 spawn 物化（runtime-spawn）共用；
 * setup 环境也在这里造，避免「资产注入」出现第二份实现。
 */
import type { Ms } from "@lingfan-video/contracts";
import type { SetupEnv } from "@lingfan-video/contracts";
import { compileSegment } from "../../domain/simulation";
import { Recorder } from "../../domain/simulation/dsl";
import type {
  CompiledSegment,
  SceneInternal,
} from "../../domain/simulation/types";
import { makeRenderError } from "./error";
import type { TimelineState } from "./engine-types";

/**
 * 编译单段：body 捕获节点流（每次出现都跑——prev 依出现上下文，不能按 id 缓存）。
 *
 * 只做登记面到编译面的转换，不碰时间线、不求值：本段在时间线上的位置由调用方决定。
 *
 * @param state 引擎状态（取画布尺寸、基础帧率、headless 与 canvas 交给 Recorder）
 * @param scene 场景内部结构（`body(prev, env)` 在这里被调用）
 * @param prev 上一段的 body 返回值（链式传参；首段为 `undefined`）
 * @param inheritedFps 链级继承帧率（spawn 链的基础采样密度）；缺省不继承
 * @returns 编译产物：单元、spawn、音频/层/总线的段内声明与内容上界
 */
export function compileScene(
  state: TimelineState,
  scene: SceneInternal<unknown>,
  prev: unknown,
  inheritedFps?: number,
): CompiledSegment {
  const { width, height, fps, headless, canvas } = state.opts;
  const rec = new Recorder(width, height, fps, headless, canvas);
  const result = scene.body(prev as never, rec);
  return compileSegment(
    scene.id,
    scene.duration,
    rec.nodes,
    result,
    fps,
    inheritedFps,
  );
}

/**
 * setup 专用环境：assets 走组合根注入的 AssetSource（core 不认平台 API）。
 *
 * 环境就是登记器的门面：setup 里的登记与 body 里的登记走同一套节点捕获。
 *
 * @param state 引擎状态（资产来源、画布尺寸、基础帧率）
 * @param scene 正在跑 setup 的场景（仅用于报错定位）
 * @returns SetupEnv：SceneEnv 的能力 + `assets.load(url)`（未装配 AssetSource 时报 spec_violation）
 */
export function makeSetupEnv(
  state: TimelineState,
  scene: SceneInternal<unknown>,
): SetupEnv {
  const { width, height, fps, headless, canvas, assets } = state.opts;
  const rec = new Recorder(width, height, fps, headless, canvas);
  const hooks = {
    load: (url: string) => {
      if (!assets)
        throw makeRenderError(
          "spec_violation",
          scene.id,
          0,
          "assets.load：引擎未装配 AssetSource（组合根缺省应注入 fail-fast 实现）",
        );
      return assets.load(url);
    },
  };
  return Object.assign(rec, { assets: hooks });
}

/**
 * thenable 判定（不用 instanceof：跨 realm 的 Promise 也要认）。
 *
 * @param value 任意值
 * @returns 该值是带 `then` 函数的对象时 `true`（视为可等待）
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * 段的内容末点：单元窗口上界（无单元时才按声明池长）——声明池是上限不是内容。
 *
 * transitionTo 会提前收窗（`activeEnd`），而单元窗口可能更早结束（例如 wait 之后
 * 没有产帧单元），两者取小才是本段真正占用的时长。
 *
 * @param seg 编译产物
 * @returns 段内局部时间的末点（毫秒）：不小于 0，不大于声明池长
 */
export function contentEndOf(seg: CompiledSegment): Ms {
  const declared = seg.activeEnd ?? seg.duration;
  if (seg.units.length === 0) return declared;
  let end = 0;
  for (const u of seg.units) if (u.windowEnd > end) end = u.windowEnd;
  return Math.min(declared, end);
}
