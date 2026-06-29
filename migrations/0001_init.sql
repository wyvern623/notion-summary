-- notion-summarizer 初期スキーマ (spec §9)
-- page_state: ページ単位の最新状態とデバウンス状態。冪等性管理の中心。
-- summary_jobs: Webhook イベントおよび Queue 実行履歴。

CREATE TABLE IF NOT EXISTS page_state (
  page_id TEXT PRIMARY KEY,
  latest_last_edited_time TEXT NOT NULL,
  debounce_until TEXT NOT NULL,
  status TEXT NOT NULL, -- pending, processing, completed, failed, skipped
  lock_until TEXT,
  last_summarized_at TEXT,
  last_summary TEXT,
  -- 投稿済み Slack チャンネルを channel->ts の JSON マップとして保持し、
  -- retry 時に投稿済みチャンネルへ再送しない (冪等性, spec §13 / 計画 §4-C)。
  slack_ts TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_page_state_status ON page_state(status);
CREATE INDEX IF NOT EXISTS idx_page_state_debounce_until ON page_state(debounce_until);

CREATE TABLE IF NOT EXISTS summary_jobs (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_last_edited_time TEXT,
  status TEXT NOT NULL, -- queued, processing, completed, failed, skipped
  skipped_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_summary_jobs_page_id ON summary_jobs(page_id);
CREATE INDEX IF NOT EXISTS idx_summary_jobs_status ON summary_jobs(status);
CREATE INDEX IF NOT EXISTS idx_summary_jobs_created_at ON summary_jobs(created_at);
