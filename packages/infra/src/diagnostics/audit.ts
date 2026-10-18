/**
 * 确定性校验：同一段推演跑两遍，逐帧指纹必须相同。
 * 分两层：`FrameHasher` 是旁路 sink（不缓存像素，长片也只占摘要），
 * `auditDeterminism` 是便捷封装（直接喂一段产帧函数跑两遍）。
 */
import type {
  FrameBitmap,
  FrameIndex,
  FrameSink,
  Ms,
} from "@lingfan-video/contracts";
import { frameFingerprint, sequenceFingerprint } from "./hash";

export interface FrameHash {
  readonly index: FrameIndex;
  readonly timestampMs: Ms;
  readonly fingerprint: string;
}

/** 旁路 sink：逐帧记指纹，像素原样转交下游（可接 MemoryFrameSink / 编码器） */
export class FrameHasher implements FrameSink {
  readonly hashes: FrameHash[] = [];

  constructor(private readonly downstream?: FrameSink) {}

  writeFrame(
    frame: FrameBitmap,
    index: FrameIndex,
    timestampMs: Ms,
  ): void | Promise<void> {
    this.hashes.push({
      index,
      timestampMs,
      fingerprint: frameFingerprint(frame),
    });
    return this.downstream?.writeFrame(frame, index, timestampMs);
  }

  finalize(): Promise<void> {
    return this.downstream ? this.downstream.finalize() : Promise.resolve();
  }

  /** 指纹序列（长度 = 帧数） */
  fingerprints(): string[] {
    return this.hashes.map((item) => item.fingerprint);
  }
}

export interface FrameMismatch {
  /** 第一个不同的位置（从 0 开始，按帧序） */
  readonly at: number;
  readonly expected: string;
  readonly actual: string;
}

export interface DeterminismReport {
  readonly identical: boolean;
  /** 两侧帧数不一致时取较大值，并在此后逐位报不同 */
  readonly frames: number;
  /** 整段指纹摘要（便于日志里一行比对） */
  readonly expected: string;
  readonly actual: string;
  readonly mismatches: readonly FrameMismatch[];
}

export interface AuditOptions {
  /** 最多列出多少个不同帧（缺省 5） */
  readonly maxMismatches?: number;
}

/** 比较两段帧指纹序列 */
export function compareFingerprints(
  baseline: readonly string[],
  candidate: readonly string[],
  options: AuditOptions = {},
): DeterminismReport {
  const maxMismatches = options.maxMismatches ?? 5;
  if (maxMismatches <= 0) {
    const err = new Error(
      `spec_violation: maxMismatches 必须是正数（收到 ${maxMismatches}）`,
    );
    err.name = "SpecViolation";
    throw err;
  }
  const frames = Math.max(baseline.length, candidate.length);
  const mismatches: FrameMismatch[] = [];
  for (let i = 0; i < frames && mismatches.length < maxMismatches; i++) {
    const expected = baseline[i];
    const actual = candidate[i];
    if (expected !== actual) {
      mismatches.push({
        at: i,
        expected: expected ?? "<缺帧>",
        actual: actual ?? "<缺帧>",
      });
    }
  }
  return {
    identical: baseline.length === candidate.length && mismatches.length === 0,
    frames,
    expected: sequenceFingerprint(baseline),
    actual: sequenceFingerprint(candidate),
    mismatches,
  };
}

/** 比较两段 FrameHash（带帧号与时间戳的版本） */
export function compareFrameHashes(
  baseline: readonly FrameHash[],
  candidate: readonly FrameHash[],
  options: AuditOptions = {},
): DeterminismReport {
  return compareFingerprints(
    baseline.map((item) => item.fingerprint),
    candidate.map((item) => item.fingerprint),
    options,
  );
}

/**
 * 跑两遍同一段产帧函数并比对指纹。
 * 注意：帧全部留在内存里（大分辨率长片会占内存），需要流式请直接用 FrameHasher。
 */
export async function auditDeterminism(
  produce: () => Promise<readonly FrameBitmap[]>,
  options: AuditOptions = {},
): Promise<DeterminismReport> {
  const first = (await produce()).map(frameFingerprint);
  const second = (await produce()).map(frameFingerprint);
  return compareFingerprints(first, second, options);
}
