/**
 * D1 リポジトリ (spec §9 / 計画 §4-B, §4-C)。
 *
 * - page_state: ページ単位の最新状態・デバウンス・processing lock・投稿済みチャンネル。
 * - summary_jobs: Webhook / Queue 実行履歴。
 *
 * 時刻は呼び出し側から ISO 文字列で渡す (テスト容易性のため内部で Date.now() を使わない)。
 * 冪等性の核心は acquireLock の条件付き UPDATE と、page_state の upsert にある。
 */
import type { D1Database } from "@cloudflare/workers-types";

export type PageStatus = "pending" | "processing" | "completed" | "failed" | "skipped";
export type JobStatus = "queued" | "processing" | "completed" | "failed" | "skipped";

export interface PageStateRow {
  page_id: string;
  latest_last_edited_time: string;
  debounce_until: string;
  status: string;
  lock_until: string | null;
  last_summarized_at: string | null;
  last_summary: string | null;
  slack_ts: string | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class Db {
  constructor(private readonly db: D1Database) {}

  /**
   * Webhook 受信時の page_state upsert (spec §8)。
   * 既存行があれば latest_last_edited_time / debounce_until / status=pending を更新する。
   */
  async upsertPageState(params: {
    pageId: string;
    latestLastEditedTime: string;
    debounceUntil: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO page_state (
           page_id, latest_last_edited_time, debounce_until, status, updated_at
         ) VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(page_id) DO UPDATE SET
           latest_last_edited_time = excluded.latest_last_edited_time,
           debounce_until = excluded.debounce_until,
           status = 'pending',
           updated_at = excluded.updated_at`,
      )
      .bind(params.pageId, params.latestLastEditedTime, params.debounceUntil, params.now)
      .run();
  }

  async getPageState(pageId: string): Promise<PageStateRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM page_state WHERE page_id = ?")
      .bind(pageId)
      .first<PageStateRow>();
    return row ?? null;
  }

  /**
   * processing lock を取得する (計画 §4-B)。
   * lock_until が未設定 or 失効済み (< now) のときだけ取得成功。
   * 条件付き UPDATE の changes() が 1 なら取得成功 = 同時実行を1つに絞れる。
   */
  async acquireLock(params: {
    pageId: string;
    now: string;
    lockUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE page_state
           SET status = 'processing', lock_until = ?, updated_at = ?
         WHERE page_id = ?
           AND (lock_until IS NULL OR lock_until < ?)`,
      )
      .bind(params.lockUntil, params.now, params.pageId, params.now)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async releaseLock(pageId: string, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE page_state SET lock_until = NULL, updated_at = ? WHERE page_id = ?")
      .bind(now, pageId)
      .run();
  }

  /** 投稿済み Slack チャンネル (channel->ts) を読み出す。未設定なら空オブジェクト。 */
  async getPostedChannels(pageId: string): Promise<Record<string, string>> {
    const row = await this.db
      .prepare("SELECT slack_ts FROM page_state WHERE page_id = ?")
      .bind(pageId)
      .first<{ slack_ts: string | null }>();
    return parseChannelMap(row?.slack_ts ?? null);
  }

  /** 投稿成功したチャンネルを slack_ts の JSON マップに追記する (冪等性, 計画 §4-C)。 */
  async addPostedChannels(params: {
    pageId: string;
    posted: Record<string, string>;
    now: string;
  }): Promise<void> {
    const existing = await this.getPostedChannels(params.pageId);
    const merged = { ...existing, ...params.posted };
    await this.db
      .prepare("UPDATE page_state SET slack_ts = ?, updated_at = ? WHERE page_id = ?")
      .bind(JSON.stringify(merged), params.now, params.pageId)
      .run();
  }

  /** 要約完了時の page_state 確定。 */
  async markPageCompleted(params: {
    pageId: string;
    summary: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE page_state
           SET status = 'completed', last_summary = ?, last_summarized_at = ?,
               lock_until = NULL, error_message = NULL, updated_at = ?
         WHERE page_id = ?`,
      )
      .bind(params.summary, params.now, params.now, params.pageId)
      .run();
  }

  async markPageStatus(params: {
    pageId: string;
    status: PageStatus;
    now: string;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE page_state
           SET status = ?, error_message = ?, lock_until = NULL, updated_at = ?
         WHERE page_id = ?`,
      )
      .bind(params.status, params.errorMessage ?? null, params.now, params.pageId)
      .run();
  }

  // --- summary_jobs ---

  async insertJob(params: {
    id: string;
    pageId: string;
    eventType: string;
    payloadLastEditedTime: string | null;
    status: JobStatus;
    queuedAt: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO summary_jobs (
           id, page_id, event_type, payload_last_edited_time, status, queued_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.pageId,
        params.eventType,
        params.payloadLastEditedTime,
        params.status,
        params.queuedAt,
        params.now,
        params.now,
      )
      .run();
  }

  /** Queue 実行結果で job の終了状態を更新する。 */
  async updateJobStatus(params: {
    id: string;
    status: JobStatus;
    now: string;
    skippedReason?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    retryCount?: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE summary_jobs
           SET status = ?,
               skipped_reason = ?,
               error_message = ?,
               started_at = COALESCE(?, started_at),
               completed_at = COALESCE(?, completed_at),
               retry_count = COALESCE(?, retry_count),
               updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        params.status,
        params.skippedReason ?? null,
        params.errorMessage ?? null,
        params.startedAt ?? null,
        params.completedAt ?? null,
        params.retryCount ?? null,
        params.now,
        params.id,
      )
      .run();
  }

  async getJob(id: string): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .prepare("SELECT * FROM summary_jobs WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    return row ?? null;
  }
}

function parseChannelMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}
