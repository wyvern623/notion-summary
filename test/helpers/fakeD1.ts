/**
 * テスト用の最小 in-memory D1 フェイク。
 * src/db.ts が発行する固定クエリだけを認識し、page_state / summary_jobs を Map に保持する。
 * 本物の SQL エンジンではないので、db.ts のクエリと対応関係を合わせて維持すること。
 */
import type { D1Database } from "@cloudflare/workers-types";

interface PageStateRow {
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

export class FakeD1 {
  pageStates = new Map<string, PageStateRow>();
  jobs = new Map<string, Record<string, unknown>>();

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return new FakeStatement(this, normalized);
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private readonly d1: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.startsWith("SELECT * FROM page_state WHERE page_id")) {
      const row = this.d1.pageStates.get(this.args[0] as string);
      return (row ?? null) as T | null;
    }
    if (sql.startsWith("SELECT slack_ts FROM page_state")) {
      const row = this.d1.pageStates.get(this.args[0] as string);
      return (row ? { slack_ts: row.slack_ts } : null) as T | null;
    }
    if (sql.startsWith("SELECT * FROM summary_jobs WHERE id")) {
      const row = this.d1.jobs.get(this.args[0] as string);
      return (row ?? null) as T | null;
    }
    throw new Error(`FakeD1: unsupported first() query: ${sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql;

    if (sql.startsWith("INSERT INTO page_state")) {
      const [pageId, latest, debounceUntil, now] = this.args as string[];
      const existing = this.d1.pageStates.get(pageId);
      if (existing) {
        existing.latest_last_edited_time = latest;
        existing.debounce_until = debounceUntil;
        existing.status = "pending";
        existing.updated_at = now;
      } else {
        this.d1.pageStates.set(pageId, {
          page_id: pageId,
          latest_last_edited_time: latest,
          debounce_until: debounceUntil,
          status: "pending",
          lock_until: null,
          last_summarized_at: null,
          last_summary: null,
          slack_ts: null,
          retry_count: 0,
          error_message: null,
          created_at: now,
          updated_at: now,
        });
      }
      return changes(1);
    }

    if (sql.startsWith("UPDATE page_state SET status = 'processing'")) {
      const [lockUntil, now, pageId, nowCompare] = this.args as string[];
      const row = this.d1.pageStates.get(pageId);
      if (!row) return changes(0);
      const free = row.lock_until === null || row.lock_until < nowCompare;
      if (!free) return changes(0);
      row.status = "processing";
      row.lock_until = lockUntil;
      row.updated_at = now;
      return changes(1);
    }

    if (sql.startsWith("UPDATE page_state SET lock_until = NULL")) {
      const [now, pageId] = this.args as string[];
      const row = this.d1.pageStates.get(pageId);
      if (!row) return changes(0);
      row.lock_until = null;
      row.updated_at = now;
      return changes(1);
    }

    if (sql.startsWith("UPDATE page_state SET slack_ts = ?")) {
      const [slackTs, now, pageId] = this.args as string[];
      const row = this.d1.pageStates.get(pageId);
      if (!row) return changes(0);
      row.slack_ts = slackTs;
      row.updated_at = now;
      return changes(1);
    }

    if (sql.startsWith("UPDATE page_state SET status = 'completed'")) {
      const [summary, summarizedAt, now, pageId] = this.args as string[];
      const row = this.d1.pageStates.get(pageId);
      if (!row) return changes(0);
      row.status = "completed";
      row.last_summary = summary;
      row.last_summarized_at = summarizedAt;
      row.lock_until = null;
      row.error_message = null;
      row.updated_at = now;
      return changes(1);
    }

    if (sql.startsWith("UPDATE page_state SET status = ?")) {
      const [status, errorMessage, now, pageId] = this.args as (string | null)[];
      const row = this.d1.pageStates.get(pageId as string);
      if (!row) return changes(0);
      row.status = status as string;
      row.error_message = (errorMessage as string | null) ?? null;
      row.lock_until = null;
      row.updated_at = now as string;
      return changes(1);
    }

    if (sql.startsWith("INSERT INTO summary_jobs")) {
      const [id, pageId, eventType, payloadLet, status, queuedAt, createdAt, updatedAt] = this
        .args as (string | null)[];
      this.d1.jobs.set(id as string, {
        id,
        page_id: pageId,
        event_type: eventType,
        payload_last_edited_time: payloadLet,
        status,
        skipped_reason: null,
        retry_count: 0,
        error_message: null,
        queued_at: queuedAt,
        started_at: null,
        completed_at: null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return changes(1);
    }

    if (sql.startsWith("UPDATE summary_jobs")) {
      const [status, skippedReason, errorMessage, startedAt, completedAt, retryCount, now, id] =
        this.args as (string | number | null)[];
      const row = this.d1.jobs.get(id as string);
      if (!row) return changes(0);
      row.status = status;
      row.skipped_reason = skippedReason ?? null;
      row.error_message = errorMessage ?? null;
      if (startedAt !== null) row.started_at = startedAt;
      if (completedAt !== null) row.completed_at = completedAt;
      if (retryCount !== null) row.retry_count = retryCount;
      row.updated_at = now;
      return changes(1);
    }

    throw new Error(`FakeD1: unsupported run() query: ${sql}`);
  }
}

function changes(n: number): { meta: { changes: number } } {
  return { meta: { changes: n } };
}
