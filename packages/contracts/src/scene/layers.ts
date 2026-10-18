import type { Ms } from "../shared/units";

/**
 * 一层的声明：剧本说「这一层什么时候在、叠在谁上面、怎么叠」，
 * 不说「用什么渲染」——渲染面由宿主按 `id` 注入。
 *
 * 这是「N 个后端同时呈现」的接缝：剧本可以声明任意多层，每层背后可以是
 * 2D 画布、WebGL、WebGPU 或任何能把结果放进一块画布的渲染器；合成端只认
 * 声明里的次序与区间，不认识渲染器。
 *
 * `from` / `to` 相对**登记位置**（与 `audio` 的 `at`、`automate` 的 `atMs` 同约定）。
 * 同一 `id` 重复登记 = 最后一处声明为准（与 `bus` 的覆盖语义一致）。
 */
export interface LayerDeclaration {
  /** 层 id：剧本与宿主之间唯一的配对键 */
  readonly id: string;
  /** 叠放次序，升序在下面；缺省按声明顺序 */
  readonly z?: number;
  /** 合成方式：`glow` 为叠加（光效层），缺省为普通 alpha 叠放 */
  readonly blend?: "normal" | "glow";
  /** 可见区间起点（相对登记位置，毫秒）；缺省 = 从登记处开始 */
  readonly from?: Ms;
  /** 可见区间终点（相对登记位置，毫秒）；缺省 = 本段收窗 */
  readonly to?: Ms;
}

/** 层登记环境：登记是声明，不消耗帧窗池、不推进游标。 */
export interface LayerEnv {
  /**
   * 登记一层画面。
   *
   * 登记顺序不影响叠放（叠放由 `z` 决定，同 `z` 再看声明顺序），
   * 所以并行分支各自声明自己那一层也不会打架。
   */
  layer(declaration: LayerDeclaration): void;
}
