/**
 * 共有型定義。
 * Cloudflare bindings (Env)、Notion / Slack の最小型を集約する。
 *
 * 無料構成: Cloudflare Queues は使わず、Cron Trigger + D1 ポーリングで遅延実行する。
 */

/** Cloudflare Workers の環境 bindings / vars / secrets。 */
export interface Env {
  // --- bindings (wrangler.toml) ---
  DB: D1Database;

  // --- vars (非機密、wrangler.toml [vars]) ---
  NOTION_VERSION?: string;
  NOTION_DATABASE_ID?: string;
  NOTION_EVENT_TYPES?: string;
  /** デバウンス: 最後の編集からこの秒数 通知が無ければ要約 (デフォルト 600=10分)。 */
  SUMMARY_DELAY_SECONDS?: string;
  /** クールダウン: 前回要約からこの秒数は次の要約を出さない (デフォルト 1800=30分)。 */
  SUMMARY_MIN_INTERVAL_SECONDS?: string;
  GEMINI_MODEL?: string;
  SUMMARY_LENGTH?: string;
  SUMMARY_STYLE?: string;
  NOTION_PAGE_SIZE?: string;
  NOTION_MAX_BLOCK_FETCHES?: string;
  NOTION_MAX_BLOCKS?: string;
  NOTION_MAX_MARKDOWN_CHARS?: string;
  DEBUG_VERBOSE?: string;
  LOG_LEVEL?: string;
  /** 失敗ジョブの最大リトライ回数 (D1 retry_count ベース。デフォルト 3)。 */
  SUMMARY_MAX_RETRIES?: string;
  /** 1 回の Cron 実行で処理するページ数の上限 (無料 subrequest 枠対策。デフォルト 3)。 */
  CRON_MAX_PAGES?: string;

  // --- secrets (wrangler secret put / .dev.vars) ---
  NOTION_API_TOKEN?: string;
  NOTION_WEBHOOK_TOKEN?: string;
  GEMINI_API_KEY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SUMMARY_CHANNEL_ID?: string;
}

export type SummaryLength = "short" | "medium" | "long";
export type SummaryStyle = "bullet" | "paragraph";

/** config.ts が env から組み立てる、デフォルト適用済みの設定値。 */
export interface AppConfig {
  notionVersion: string;
  notionDatabaseId?: string;
  notionEventTypes: string[];
  summaryDelaySeconds: number;
  summaryMinIntervalSeconds: number;
  geminiModel: string;
  summaryLength: SummaryLength;
  summaryStyle: SummaryStyle;
  notionPageSize: number;
  notionMaxBlockFetches: number;
  notionMaxBlocks: number;
  notionMaxMarkdownChars: number;
  debugVerbose: boolean;
  logLevel: LogLevel;
  summaryMaxRetries: number;
  cronMaxPages: number;
  // secrets (存在しない可能性がある — 利用箇所でガードする)
  notionApiToken?: string;
  notionWebhookToken?: string;
  geminiApiKey?: string;
  slackBotToken?: string;
  slackChannelIds: string[];
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** Notion ページ取得結果のうち、要約に必要な最小情報。 */
export interface NotionPageInfo {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
  parentDatabaseId?: string;
}

/** Markdown 化された本文と、省略が発生したかどうか。 */
export interface NotionPageContent {
  markdown: string;
  blockCount: number;
  truncated: boolean;
}

/** Slack 1 チャンネルへの投稿結果。 */
export interface SlackPostResult {
  channel: string;
  ok: boolean;
  ts?: string;
  error?: string;
}
