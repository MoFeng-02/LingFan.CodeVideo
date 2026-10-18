/**
 * 随机源装配：程序级种子归一化，以及单元随机子流的惰性派生与缓存。
 *
 * 确定性口径：种子只在开工时读一次；每个单元按标签 fork 自己的子流，
 * 因而「同 seed + 同剧本」必得同序列，且增删一个单元不会改变其他单元的抽取。
 */
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
 *
 * @param seed 调用方给的整场随机种子；`undefined` 表示未指定
 * @returns 可直接建流的种子（未指定时为 DEFAULT_PROGRAM_SEED）
 * @throws RenderError（kind = spec_violation）种子不是合法整数时
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
 *
 * @param state 引擎运行期状态（子流缓存挂在 `state.randomStreams` 上）
 * @param label 流标签，由 {@link randomLabel} 生成
 * @returns 该标签对应的随机子流；同一标签多次调用返回同一实例
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
 *
 * @param unitKey 编译期分配的单元键（如 `step#3`、`loop#1:0`）
 * @param spawnKey spawn 链键；主链单元传 `null`
 * @returns 流标签：主链单元即 `unitKey`，spawn 单元为 `spawnKey/unitKey`
 */
export function randomLabel(unitKey: string, spawnKey: string | null): string {
  return spawnKey === null ? unitKey : `${spawnKey}/${unitKey}`;
}

/**
 * 建程序随机源（引擎开工时调用一次）。
 *
 * @param seed 原始种子（未指定则用 DEFAULT_PROGRAM_SEED）
 * @returns 整场共用的根随机流，单元子流由它 fork 出来
 */
export function createProgramRandom(seed: number | undefined): RandomStream {
  return createRandomStream(programSeed(seed));
}
