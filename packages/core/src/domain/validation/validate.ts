import type { Ms, Scene, ValidationError } from "@lingfan-video/contracts";
import type { SceneInternal, SimNode } from "../simulation/types";
import { Recorder } from "../simulation/dsl";

/**
 * 契约符合性检查：纯检查、无副作用、可对未渲染剧本前置运行。
 * 做法：干跑登记（Recorder 捕获节点流），再对节点流做结构性检查。
 * 检查项：window_overflow（step at/duration 越窗类 bug）、
 * spec_violation（重复链接、body 抛错、spawn key 段内重复）。
 */
export function validate(scene: Scene<unknown>, fps = 60): ValidationError[] {
  const head = scene as SceneInternal<unknown>;
  const errors: ValidationError[] = [];
  const seenIds = new Set<string>();
  let cur: SceneInternal<unknown> | undefined = head;

  while (cur) {
    if (seenIds.has(cur.id)) {
      errors.push({
        path: cur.id,
        code: "spec_violation",
        message: `剧本链出现环或重复段 ${cur.id}`,
      });
      break;
    }
    seenIds.add(cur.id);
    errors.push(...validateSegment(cur, fps));
    cur = cur.next;
  }
  return errors;
}

function validateSegment(
  scene: SceneInternal<unknown>,
  fps: number,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const recorder = new Recorder(
    0,
    0,
    fps,
    true,
    null as unknown as Recorder["canvas"],
  );
  try {
    scene.body(undefined as never, recorder);
  } catch (e) {
    return [
      {
        path: scene.id,
        code: "spec_violation",
        message: `body 干跑抛错：${(e as Error).message}`,
      },
    ];
  }
  const spawnKeys = new Set<string>();
  checkNodes(
    scene.id,
    recorder.nodes,
    0 as Ms,
    scene.duration,
    errors,
    spawnKeys,
  );
  return errors;
}

function checkNodes(
  path: string,
  nodes: SimNode[],
  base: Ms,
  windowEnd: Ms,
  errors: ValidationError[],
  spawnKeys: Set<string>,
): void {
  let cursor: Ms = base;
  for (const n of nodes) {
    switch (n.kind) {
      case "step": {
        const start = cursor + (n.at ?? 0);
        if (start < 0)
          errors.push({
            path,
            code: "spec_violation",
            message: `step at=${n.at} 使起点为负`,
          });
        // 单元声明帧率须为正（缺省 = 继承/基础，无需检查）
        if (n.fps !== undefined && (!(n.fps > 0) || !Number.isFinite(n.fps)))
          errors.push({
            path,
            code: "spec_violation",
            message: `step fps=${n.fps} 非正数（采样密度须 > 0）`,
          });
        if (start >= windowEnd || start + n.duration > windowEnd + 1e-6) {
          errors.push({
            path,
            code: "window_overflow",
            message: `step 窗口 [${start}, ${start + n.duration}) 越段窗 [${base}, ${windowEnd})`,
          });
        }
        cursor += n.duration;
        break;
      }
      case "wait":
        cursor += n.duration;
        break;
      case "loop":
        if (n.fps !== undefined && (!(n.fps > 0) || !Number.isFinite(n.fps)))
          errors.push({
            path,
            code: "spec_violation",
            message: `loop fps=${n.fps} 非正数（采样密度须 > 0）`,
          });
        if (n.ms !== undefined)
          cursor += Math.min(n.ms * (n.times ?? Infinity), windowEnd - cursor);
        break;
      case "par": {
        let maxPool: Ms = 0;
        for (const branch of n.children) {
          const subKeys = spawnKeys; // 段内 spawn key 检查贯穿分支
          checkNodes(`${path}/par`, branch, cursor, windowEnd, errors, subKeys);
          // 分支池：分支内最后一个节点后的 cursor 偏移（wait-only 分支为 0）
          maxPool = Math.max(maxPool, branchCursorEnd(branch, cursor) - cursor);
        }
        cursor += maxPool;
        break;
      }
      case "spawn": {
        if (spawnKeys.has(n.options.key)) {
          errors.push({
            path,
            code: "spec_violation",
            message: `spawn key "${n.options.key}" 段内重复（同 key 去重通道被二义使用）`,
          });
        }
        spawnKeys.add(n.options.key);
        // 组合约束：forever 与显式 duration 互斥（寿命二义）
        if (n.options.forever && n.options.duration !== undefined) {
          errors.push({
            path,
            code: "spec_violation",
            message: `spawn "${n.options.key}" 同时给 forever 与 duration=${n.options.duration}（寿命二义：forever 活到总链尾/kill，duration 是显式覆盖）`,
          });
        }
        if (n.options.duration !== undefined && n.options.duration < 0) {
          errors.push({
            path,
            code: "spec_violation",
            message: `spawn "${n.options.key}" duration=${n.options.duration} 为负`,
          });
        }
        if (
          n.options.fps !== undefined &&
          (!(n.options.fps > 0) || !Number.isFinite(n.options.fps))
        ) {
          errors.push({
            path,
            code: "spec_violation",
            message: `spawn "${n.options.key}" fps=${n.options.fps} 非正数（采样密度须 > 0）`,
          });
        }
        break;
      }
      case "transition":
        return; // 提前收窗：其后节点不活跃，不再检查
      case "audio":
        checkAudioWarp(path, n, errors);
        break;
    }
  }
}

/**
 * 音频时间映射检查：锚点时间严格递增、源位置单调（速率必为正，禁倒放）、
 * 源尾标志 "end" 仅允许末位（否则其后的锚点无意义）。
 */
function checkAudioWarp(
  path: string,
  n: Extract<SimNode, { kind: "audio" }>,
  errors: ValidationError[],
): void {
  const warp = n.options.warp;
  if (warp === undefined) return;
  const tag = `audio "${n.clipUrl}" warp`;
  const push = (message: string): void => {
    errors.push({ path, code: "spec_violation", message });
  };
  if (warp.length === 0) {
    push(`${tag} 为空数组（省略即原速；空数组无意义）`);
    return;
  }
  let prevAt = -Infinity;
  let prevSrc = -Infinity;
  for (let i = 0; i < warp.length; i++) {
    const p = warp[i]!;
    if (!Number.isFinite(p.atMs) || p.atMs < 0) {
      push(`${tag} 第 ${i} 点 atMs=${p.atMs} 非法（须为 ≥0 的有限毫秒）`);
      continue;
    }
    if (p.atMs <= prevAt) {
      push(`${tag} 第 ${i} 点 atMs=${p.atMs} 未严格递增（前一点 ${prevAt}）`);
    }
    prevAt = p.atMs;
    if (p.srcMs === "end") {
      if (i !== warp.length - 1) {
        push(`${tag} 第 ${i} 点 srcMs="end" 只允许末位（源尾之后无锚点可言）`);
      }
      continue;
    }
    if (!Number.isFinite(p.srcMs) || p.srcMs < 0) {
      push(
        `${tag} 第 ${i} 点 srcMs=${String(p.srcMs)} 非法（须为 ≥0 的有限毫秒或 "end"）`,
      );
      continue;
    }
    if (p.srcMs <= prevSrc) {
      push(
        `${tag} 第 ${i} 点 srcMs=${p.srcMs} 未递增（前一点 ${prevSrc}）——速率须为正，禁倒放`,
      );
    }
    prevSrc = p.srcMs;
  }
}

/** 分支展平后的终点 cursor（不含 par 嵌套误差——渲染期 evaluator 为精确账本） */
function branchCursorEnd(branch: SimNode[], base: Ms): Ms {
  let c: Ms = base;
  for (const n of branch) {
    if (n.kind === "step" || n.kind === "wait") c += n.duration;
    else if (n.kind === "loop" && n.ms !== undefined)
      c += Math.min(n.ms * (n.times ?? Infinity), Number.MAX_SAFE_INTEGER);
  }
  return c;
}
