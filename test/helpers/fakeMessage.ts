/** テスト用の Queue Message フェイク。ack / retry の呼び出しを記録する。 */
import type { QueueMessageLike } from "../../src/handlers/consumer.js";

export class FakeMessage<T> implements QueueMessageLike<T> {
  acked = false;
  retried = false;
  retryOptions: { delaySeconds?: number } | undefined;

  constructor(
    public body: T,
    public attempts = 1,
  ) {}

  ack(): void {
    this.acked = true;
  }

  retry(options?: { delaySeconds?: number }): void {
    this.retried = true;
    this.retryOptions = options;
  }
}
