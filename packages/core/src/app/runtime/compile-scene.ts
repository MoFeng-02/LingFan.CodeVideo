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

/** 编译单段：body 捕获节点流（每次出现都跑——prev 依出现上下文，不能按 id 缓存） */
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

/** setup 专用环境：assets 走组合根注入的 AssetSource（core 不认平台 API） */
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

/** thenable 判定（不用 instanceof：跨 realm 的 Promise 也要认） */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/** 段的内容末点：单元窗口上界（无单元时才按声明池长）——声明池是上限不是内容 */
export function contentEndOf(seg: CompiledSegment): Ms {
  const declared = seg.activeEnd ?? seg.duration;
  if (seg.units.length === 0) return declared;
  let end = 0;
  for (const u of seg.units) if (u.windowEnd > end) end = u.windowEnd;
  return Math.min(declared, end);
}
