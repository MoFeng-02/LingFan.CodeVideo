import {
  DEFAULT_PROGRAM_SEED,
  type RandomStream,
} from "@lingfan-video/contracts";
import { createRandomStream, seedError } from "../../domain/random";
import { makeRenderError } from "./error";
import type { TimelineState } from "./engine-types";

/**
 * 程序种子归一化：缺省 = DEFAULT_PROGRAM_SEED；非法值在开工前炸，
 * 不让「种子写错」变成一场悄悄换掉的抽取。
 */
export function programSeed(seed: number | undefined): number {
  if (seed === undefined) return DEFAULT_PROGRAM_SEED;
  const problem = seedError(seed);
  if (problem !== null)
    throw makeRenderError("spec_violation", "seed", 0, problem);
  return seed;
}

/**
 * 单元随机流：按 `sceneId/unitKey[@spawnKey]` 惰性派生并缓存。
 * 同一单元实例跨帧拿到同一条流（序列连续）；不同单元各走各的子流，
 * 所以新增/删除一个单元不会改变其他单元抽到的数。
 */
export function unitRandomStream(
  state: TimelineState,
  label: string,
): RandomStream {
  const cached = state.randomStreams.get(label);
  if (cached !== undefined) return cached;
  const stream = state.random.fork(label);
  state.randomStreams.set(label, stream);
  return stream;
}

/**
 * 单元随机流标签：单元键（spawn 实例再加链键）。
 * 刻意不用场景的内部编号——那是构造计数器，同一剧本重建一次编号就变，
 * 而「同 seed 同剧本应得同结果」不能依赖全局构造顺序。
 */
export function randomLabel(unitKey: string, spawnKey: string | null): string {
  return spawnKey === null ? unitKey : `${spawnKey}/${unitKey}`;
}

/** 建程序随机源（引擎开工时调用一次） */
export function createProgramRandom(seed: number | undefined): RandomStream {
  return createRandomStream(programSeed(seed));
}
