/**
 * 确定性校验：同一段推演跑两遍，逐帧指纹必须相同。
 * 分两层：`FrameHasher` 是旁路 sink（不缓存像素，长片也只占摘要），
 * `auditDeterminism` 是便捷封装（直接喂一段产帧函数跑两遍）。
 *
 * 适用范围：比对的是**像素与尺寸**（见 `frameFingerprint`），因此同一份
 * 剧本在不同机器上只要合成结果一致就能通过；但编码器产物、时序抖动、
 * 系统字体等渲染端差异不在校验范围内，需要另行取样。
 */
import type {
  FrameBitmap,
  FrameCarrier,
  FrameIndex,
  FrameSink,
  Ms,
} from "@lingfan-video/contracts";
import { isFrameHandle } from "../frames/carrier";
import { frameFingerprint, sequenceFingerprint } from "./hash";

/** 单帧的指纹记录：帧号 + 时间戳 + 指纹，便于把差异定位回时间轴 */
export interface FrameHash {
  /** 帧号（从 0 开始，按收帧顺序） */
  readonly index: FrameIndex;
  /** 该帧在推演时间轴上的位置（毫秒） */
  readonly timestampMs: Ms;
  /** 帧指纹（16 位小写十六进制，见 `frameFingerprint`） */
  readonly fingerprint: string;
}

/**
 * 载体指纹：位图直算；设备句柄只有「原生对象是 2D 画布」时才能回读，
 * 其余情况明确报错——确定性校验不接受「静默当成同一帧」。
 *
 * @param frame 待取样帧；句柄会尝试在其原生画布上 `getImageData`
 * @returns 16 位小写十六进制指纹
 */
function carrierFingerprint(frame: FrameCarrier): string {
  if (!isFrameHandle(frame)) return frameFingerprint(frame);
  const native = frame.native as { getContext?: (id: string) => unknown };
  const g = native.getContext?.("2d") as
    | {
        getImageData?: (
          x: number,
          y: number,
          w: number,
          h: number,
        ) => ImageData;
      }
    | undefined;
  const pixels = g?.getImageData?.(0, 0, frame.width, frame.height);
  if (!pixels) {
    throw new Error(
      "确定性指纹需要 CPU 像素：设备侧句柄不是 2D 画布，无法回读——请让后端交位图，或改在编码前旁路取样",
    );
  }
  return frameFingerprint({
    data: pixels.data,
    width: frame.width,
    height: frame.height,
  });
}

/**
 * 旁路 sink：逐帧记指纹，像素原样转交下游（可接 MemoryFrameSink / 编码器）。
 *
 * 挂在推演管线的 sink 位置即用，不改动帧内容、不持有像素，
 * 所以长片也只占「帧数 × 一个指纹文本」的内存。设备句柄需能回读成像素，
 * 否则 `writeFrame` 抛错（错误发生在收帧时，不会拖到比对阶段）。
 */
export class FrameHasher implements FrameSink {
  /** 已收帧的指纹记录（按收帧顺序，长度 = 已收帧数） */
  readonly hashes: FrameHash[] = [];

  /**
   * @param downstream 可选的下游 sink；给出则每帧记录后原样转发，
   *   `finalize` 也一并转发，因此本类可以透明地插在链路中间
   */
  constructor(private readonly downstream?: FrameSink) {}

  /**
   * 记录一帧指纹并转发给下游。
   *
   * 转发在记录之后同步进行；下游若返回 Promise，本方法把该 Promise 交回
   * 上游等待（推演管线据此形成背压），本类自身不做缓冲。
   *
   * @param frame 帧载体；设备句柄必须可回读为像素
   * @param index 帧号（从 0 开始），原样记录与转发
   * @param timestampMs 时间戳（毫秒），原样记录与转发
   */
  writeFrame(
    frame: FrameCarrier,
    index: FrameIndex,
    timestampMs: Ms,
  ): void | Promise<void> {
    this.hashes.push({
      index,
      timestampMs,
      fingerprint: carrierFingerprint(frame),
    });
    return this.downstream?.writeFrame(frame, index, timestampMs);
  }

  /** 收尾：有下游则等下游收尾，没有下游立即完成 */
  finalize(): Promise<void> {
    return this.downstream ? this.downstream.finalize() : Promise.resolve();
  }

  /**
   * 指纹序列（长度 = 帧数），按收帧顺序，可直接喂 `compareFingerprints`。
   */
  fingerprints(): string[] {
    return this.hashes.map((item) => item.fingerprint);
  }
}

/** 一处不同：出现在第几帧、两侧各自的指纹 */
export interface FrameMismatch {
  /** 第一个不同的位置（从 0 开始，按帧序） */
  readonly at: number;
  /** 基准侧指纹；该帧缺失时为占位文本 `<缺帧>` */
  readonly expected: string;
  /** 候选侧指纹；该帧缺失时为占位文本 `<缺帧>` */
  readonly actual: string;
}

/** 一次确定性比对的结论：是否完全一致、差异在哪几帧 */
export interface DeterminismReport {
  /** 两侧帧数相同且无任何指纹差异时为 `true` */
  readonly identical: boolean;
  /** 参与比对的帧数：两侧帧数不一致时取较大值，并在此后逐位报不同 */
  readonly frames: number;
  /** 整段指纹摘要（便于日志里一行比对） */
  readonly expected: string;
  /** 候选侧的整段指纹摘要，与 `expected` 同算法 */
  readonly actual: string;
  /** 差异列表，按帧序升序，最多 `maxMismatches` 条（不截断帧数统计） */
  readonly mismatches: readonly FrameMismatch[];
}

/** 比对参数 */
export interface AuditOptions {
  /** 最多列出多少条差异（缺省 5）；必须是正数，否则抛 spec_violation */
  readonly maxMismatches?: number;
}

/**
 * 比较两段帧指纹序列。
 *
 * 两侧长度可以不同：多出来的那侧逐帧记 `<缺帧>` 差异，并且 `frames` 取
 * 较大值。差异列表按 `maxMismatches` 截断，但 `identical` 与 `frames`
 * 仍按全量判断。
 *
 * @param baseline 基准侧逐帧指纹（按帧序）
 * @param candidate 候选侧逐帧指纹（按帧序）
 * @param options 比对参数，缺省 `{}`（即最多列 5 处差异）
 * @returns 比对报告
 */
export function compareFingerprints(
  baseline: readonly string[],
  candidate: readonly string[],
  options: AuditOptions = {},
): DeterminismReport {
  /** 差异列表上限：截断只为报告可读，不影响一致性判定 */
  const maxMismatches = options.maxMismatches ?? 5;
  if (maxMismatches <= 0) {
    /** 参数越界的错误：`maxMismatches` 必须是正数才有意义 */
    const err = new Error(
      `spec_violation: maxMismatches 必须是正数（收到 ${maxMismatches}）`,
    );
    err.name = "SpecViolation";
    throw err;
  }
  /** 比对长度：取两侧较大值，短的一侧按缺帧处理 */
  const frames = Math.max(baseline.length, candidate.length);
  /** 逐帧差异，达到上限即停止收集 */
  const mismatches: FrameMismatch[] = [];
  for (let i = 0; i < frames && mismatches.length < maxMismatches; i++) {
    /** 基准侧该帧指纹 */
    const expected = baseline[i];
    /** 候选侧该帧指纹 */
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

/**
 * 比较两段 FrameHash（带帧号与时间戳的版本）。
 *
 * 只按指纹比对，帧号与时间戳仅用于定位；返回报告与 `compareFingerprints` 一致。
 *
 * @param baseline 基准侧逐帧记录
 * @param candidate 候选侧逐帧记录
 * @param options 比对参数，缺省 `{}`
 * @returns 比对报告
 */
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
 *
 * 两遍是背靠背执行的（第一遍收集完才开始第二遍），期间不要有共享可变
 * 状态被第一次调用改动，否则差异会被当作不确定性报出。
 *
 * @param produce 产帧函数：调用一次返回整段推演的帧序列，需可重复执行
 * @param options 比对参数，缺省 `{}`
 * @returns 两次执行的比对报告
 */
export async function auditDeterminism(
  produce: () => Promise<readonly FrameBitmap[]>,
  options: AuditOptions = {},
): Promise<DeterminismReport> {
  /** 第一遍的逐帧指纹 */
  const first = (await produce()).map(frameFingerprint);
  /** 第二遍的逐帧指纹 */
  const second = (await produce()).map(frameFingerprint);
  return compareFingerprints(first, second, options);
}
