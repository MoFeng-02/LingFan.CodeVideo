/**
 * 逐段登记：把一批片段按顺序交给引擎，每段声明自己的层与采样密度。
 *
 * 抽出来是因为「逐段登记」有两个消费方（整章 / 演示片段），写法只能有一份——
 * 两处各写一遍就会在层 id 或 step 参数上慢慢分叉。
 */
import type {
  FrameState,
  SceneEnv,
  StepContext,
} from "@lingfan-video/contracts";
import type { LedgerState, Painters } from "../frames/frame";
import type { Shot } from "../script/types";

/**
 * 逐段 step 一段片段序列。
 *
 * @param env 登记目标（章的分支或独立片段）
 * @param shots 要登记的片段（按播放顺序）
 * @param frames 与 `shots` 一一对应的 fn
 * @param painters 每帧算出的状态画进哪几层
 */
export function scheduleShots(
  env: SceneEnv,
  shots: readonly Shot[],
  frames: readonly ((ctx: StepContext) => LedgerState)[],
  painters: Painters,
): void {
  for (const [index, shot] of shots.entries()) {
    const fn = frames[index]!;
    // 层随段声明：不写窗口长度，活到本段末尾；下一镜用新 id 再声明一次
    env.layer({ id: `field:${shot.id}`, z: 0 });
    env.layer({ id: `type:${shot.id}`, z: 10 });
    env.step(
      shot.length,
      (ctx) => {
        const state = fn(ctx);
        painters.field?.paint(state);
        painters.type?.paint(state);
        return state as FrameState;
      },
      { fps: shot.fps },
    );
  }
}
