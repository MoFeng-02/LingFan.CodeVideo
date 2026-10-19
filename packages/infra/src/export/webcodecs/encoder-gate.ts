/**
 * 编码错误的接力与编码队列背压：视频轨与音频轨共用的失败通道。
 *
 * 编码器的 `error` 回调与 `ondequeue` 都不在写调用链上，`throw` 只会变成未捕获
 * 异常。这里把首个错误存下来，之后任何写入/收尾以及正在等待出队的调用方都按
 * 同一错误失败，不会静默继续。
 */
import { MAX_ENCODE_QUEUE } from "./types";

/** 首个编码错误的中转站：错误只记录一次，唤醒所有等待者 */
export class EncoderGate {
  /** 首个失败；非 null 之后一切写入/收尾都抛出它 */
  private failure: Error | null = null;
  /** 正在等待编码队列出队的调用方（错误到来时统一唤醒，避免永远卡住） */
  private waiters: (() => void)[] = [];

  /**
   * 记录首个异步编码错误并唤醒所有等待出队的调用方。
   *
   * @param error 编码器报告的失败
   */
  fail(error: Error): void {
    if (this.failure === null) this.failure = error;
    this.wake();
  }

  /** 已记录编码错误时抛出：同一错误一直沿用到实例被丢弃 */
  throwIfFailed(): void {
    if (this.failure !== null) throw this.failure;
  }

  /**
   * 编码队列过深时等待出队（长音频不能无限堆积；编码错误同样走这条唤醒）。
   *
   * @param encoder 视频或音频编码器
   */
  async drain(encoder: VideoEncoder | AudioEncoder): Promise<void> {
    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      this.throwIfFailed();
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        encoder.ondequeue = () => this.wake();
      });
    }
    this.throwIfFailed();
  }

  /** 唤醒所有等待出队的调用方（正常出队与错误共用这条唤醒） */
  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
