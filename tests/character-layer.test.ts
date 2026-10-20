/**
 * 角色层跨引擎语义：角色的轨迹只由故事时间决定，采样密度与求值次数是调度方的自由；
 * 角色作为一层参与合成时，区间与叠放次序遵循场景层调度。
 * 全部判据离线可跑：不需要画布与 GPU。
 */
import { describe, expect, it } from "vitest";
import type { FrameIndex, Ms } from "@lingfan-video/contracts";
import type { LayerSpec } from "@lingfan-video/infra";
import { planComposite } from "@lingfan-video/infra";
import type { DrawPlan } from "@lingfan-character/renderer-canvas2d";
import {
  buildDrawPlan,
  fingerprint,
} from "@lingfan-character/renderer-canvas2d";
import { createCharacterRuntime } from "@lingfan-character/kernel";
import { humanoidPack } from "@lingfan-character/example-humanoid";

const runtime = createCharacterRuntime(humanoidPack);

/** 求值到指纹：把角色压缩成一行可逐字节比对的数据 */
async function fingerprintAt(t: Ms): Promise<string> {
  const state = await runtime.computeAt(t);
  const plan: DrawPlan = buildDrawPlan(state, 512);
  return fingerprint(plan);
}

describe("角色层：被引擎驱动的时间语义", () => {
  it("采样密度不改角色轨迹：粗网格点在细网格轨迹上逐字节同值", async () => {
    const FINE_STEP = 20;
    const COARSE_STEP = 100;
    const HORIZON = 1000;
    const fine: string[] = [];
    for (let t = 0; t <= HORIZON; t += FINE_STEP) {
      fine.push(await fingerprintAt(t));
    }
    const coarseCount = HORIZON / COARSE_STEP;
    for (let index = 0; index <= coarseCount; index += 1) {
      const coarse = await fingerprintAt(index * COARSE_STEP);
      expect(coarse).toBe(fine[index * (COARSE_STEP / FINE_STEP)]!);
    }
  });

  it("重放一致：同一时刻重复求值得到同一指令流", async () => {
    const first = await fingerprintAt(370);
    const second = await fingerprintAt(370);
    expect(second).toBe(first);
  });
});

describe("角色层：作为一层参与合成", () => {
  function fakeLayer(spec: LayerSpec) {
    return {
      spec,
      surface: {
        id: spec.id,
        width: 8,
        height: 8,
        canvas: { width: 8, height: 8 } as unknown as HTMLCanvasElement,
        render(_frame: FrameIndex, _t: Ms): void {},
      },
    };
  }

  it("叠放次序由 z 决定，角色层在背景之上", () => {
    const plan = planComposite(
      [
        fakeLayer({ id: "character", z: 1 }),
        fakeLayer({ id: "backdrop", z: 0 }),
      ],
      100,
    );
    expect(plan.map((l) => l.spec.id)).toEqual(["backdrop", "character"]);
  });

  it("角色层遵循剧本声明的可见区间（左闭右开）", () => {
    const spec: LayerSpec = { id: "character", z: 1, from: 300, to: 900 };
    const plan = planComposite([fakeLayer(spec)], 500);
    expect(plan.map((l) => l.spec.id)).toEqual(["character"]);
    expect(planComposite([fakeLayer(spec)], 900)).toEqual([]);
  });
});
