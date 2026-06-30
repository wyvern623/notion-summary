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
   * Webhook 受信時の page_state upsert (軽量構成)。
   * debounce_until を更新し status=pending にするだけ。Notion は叩かない。
   * latest_last_edited_time は「最後に要約した版の last_edited_time」を表し (Cron が設定)、
   * ここでは新規挿入時に空文字を入れ、既存行では**上書きしない**(重複防止の基準を保つ)。
   */
  async upsertPageState(params: {
    pageId: string;
    debounceUntil: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO page_state (
           page_id, latest_last_edited_time, debounce_until, status, updated_at
         ) VALUES (?, '', ?, 'pending', ?)
         ON CONFLICT(page_id) DO UPDATE SET
           debounce_until = excluded.debounce_until,
           status = 'pending',
           updated_at = excluded.updated_at`,
      )
      .bind(params.pageId, params.debounceUntil, params.now)
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
   * Cron で処理すべき「期限到来済み」のページを取得する (無料構成のデバウンス実体)。
   * status='pending' かつ debounce_until <= now かつ lock が空き、のものを古い順に limit 件。
   * lock の最終ガードは acquireLock 側の条件付き UPDATE で行う。
   */
  async getDuePages(now: string, limit: number): Promise<PageStateRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM page_state
         WHERE status = 'pending'
           AND debounce_until <= ?
           AND (lock_until IS NULL OR lock_until < ?)
         ORDER BY debounce_until ASC
         LIMIT ?`,
      )
      .bind(now, now, limit)
      .all<PageStateRow>();
    return result.results ?? [];
  }

  /** ページに紐づく最新の summary_jobs を返す (Cron 実行結果の記録対象)。 */
  async getLatestJobByPage(pageId: string): Promise<{ id: string } | null> {
    const row = await this.db
      .prepare("SELECT id FROM summary_jobs WHERE page_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(pageId)
      .first<{ id: string }>();
    return row ?? null;
  }

  /**
   * retryable 失敗時に retry_count を +1 し、status=pending に戻して lock を解放する。
   * 次の Cron tick で再度 due として拾われる。
   */
  async bumpRetry(pageId: string, now: string, errorMessage: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE page_state
           SET status = 'pending', lock_until = NULL,
               retry_count = retry_count + 1, error_message = ?, updated_at = ?
         WHERE page_id = ?`,
      )
      .bind(errorMessage, now, pageId)
      .run();
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

  /**
   * 要約完了時の page_state 確定。
   * - latest_last_edited_time に「今要約した版の last_edited_time」を記録 (次回の重複判定基準)。
   * - 処理中に新しい Webhook が来て debounce_until が変わっていた場合 (expectedDebounceUntil と不一致)、
   *   completed にせず pending のまま残す → 次の Cron で新しい編集を要約する (編集の取りこぼし防止)。
   */
  async markPageCompleted(params: {
    pageId: string;
    lastEditedTime: string;
    summary: string;
    expectedDebounceUntil: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE page_state
           SET status = CASE WHEN debounce_until = ? THEN 'completed' ELSE 'pending' END,
               latest_last_edited_time = ?,
               last_summary = ?, last_summarized_at = ?,
               lock_until = NULL, error_message = NULL, updated_at = ?
         WHERE page_id = ?`,
      )
      .bind(
        params.expectedDebounceUntil,
        params.lastEditedTime,
        params.summary,
        params.now,
        params.now,
        params.pageId,
      )
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
