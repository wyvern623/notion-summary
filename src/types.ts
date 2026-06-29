/**
 * 共有型定義。
 * Cloudflare bindings (Env)、Queue payload、Notion / Slack の最小型を集約する。
 */

/** Cloudflare Workers の環境 bindings / vars / secrets。 */
export interface Env {
  // --- bindings (wrangler.toml) ---
  DB: D1Database;
  SUMMARY_QUEUE: Queue<SummaryJobMessage>;

  // --- vars (非機密、wrangler.toml [vars]) ---
  NOTION_VERSION?: string;
  NOTION_DATABASE_ID?: string;
  NOTION_EVENT_TYPES?: string;
  SUMMARY_DELAY_SECONDS?: string;
  GEMINI_MODEL?: string;
  SUMMARY_LENGTH?: string;
  SUMMARY_STYLE?: string;
  NOTION_PAGE_SIZE?: string;
  NOTION_MAX_BLOCK_FETCHES?: string;
  NOTION_MAX_BLOCKS?: string;
  NOTION_MAX_MARKDOWN_CHARS?: string;
  DEBUG_VERBOSE?: string;
  LOG_LEVEL?: string;
  /** wrangler.toml の consumer 設定 max_retries と一致させる (デフォルト 3)。 */
  QUEUE_MAX_RETRIES?: string;

  // --- secrets (wrangler secret put / .dev.vars) ---
  NOTION_API_TOKEN?: string;
  NOTION_WEBHOOK_TOKEN?: string;
  GEMINI_API_KEY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SUMMARY_CHANNEL_ID?: string;
}

/** Queue に投入する要約ジョブのメッセージ本体。秘密情報・本文全文は含めない。 */
export interface SummaryJobMessage {
  job_id: string;
  page_id: string;
  event_type: string;
  last_edited_time: string;
  queued_at: string;
}

export type SummaryLength = "short" | "medium" | "long";
export type SummaryStyle = "bullet" | "paragraph";

/** config.ts が env から組み立てる、デフォルト適用済みの設定値。 */
export interface AppConfig {
  notionVersion: string;
  notionDatabaseId?: string;
  notionEventTypes: string[];
  summaryDelaySeconds: number;
  geminiModel: string;
  summaryLength: SummaryLength;
  summaryStyle: SummaryStyle;
  notionPageSize: number;
  notionMaxBlockFetches: number;
  notionMaxBlocks: number;
  notionMaxMarkdownChars: number;
  debugVerbose: boolean;
  logLevel: LogLevel;
  queueMaxRetries: number;
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
