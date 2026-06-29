/**
 * テスト用の最小 Queue フェイク。送信メッセージを記録する。
 * failSend=true で send を失敗させ、queue_error 系の分岐を検証できる。
 */
import type { Queue } from "@cloudflare/workers-types";

export class FakeQueue<T = unknown> {
  sent: Array<{ body: T; options?: { delaySeconds?: number } }> = [];
  failSend = false;

  asQueue(): Queue<T> {
    return this as unknown as Queue<T>;
  }

  send = async (body: T, options?: { delaySeconds?: number }): Promise<void> => {
    if (this.failSend) throw new Error("queue send failed");
    this.sent.push({ body, options });
  };
}
