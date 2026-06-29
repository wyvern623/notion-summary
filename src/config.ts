/**
 * env bindings / vars / secrets から型付き AppConfig を組み立てる。
 * vars にはデフォルトを適用し、secrets はそのまま読む (利用箇所でガード)。
 */
import type { AppConfig, Env, LogLevel, SummaryLength, SummaryStyle } from "./types.js";

const DEFAULTS = {
  notionVersion: "2022-06-28",
  notionEventTypes: "page.content_updated,page.created",
  summaryDelaySeconds: 600,
  geminiModel: "gemini-2.5-flash-lite",
  summaryLength: "medium" as SummaryLength,
  summaryStyle: "bullet" as SummaryStyle,
  notionPageSize: 100,
  notionMaxBlockFetches: 40,
  notionMaxBlocks: 800,
  notionMaxMarkdownChars: 30000,
  debugVerbose: false,
  logLevel: "INFO" as LogLevel,
  queueMaxRetries: 3,
} as const;

const VALID_LENGTHS: readonly SummaryLength[] = ["short", "medium", "long"];
const VALID_STYLES: readonly SummaryStyle[] = ["bullet", "paragraph"];
const VALID_LOG_LEVELS: readonly LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

/** 文字列 var を正の整数として解釈。空・不正値はデフォルトに落とす。 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

/** カンマ区切り文字列を trim 済み非空要素の配列にする。 */
export function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(env: Env): AppConfig {
  const summaryLength = VALID_LENGTHS.includes(env.SUMMARY_LENGTH as SummaryLength)
    ? (env.SUMMARY_LENGTH as SummaryLength)
    : DEFAULTS.summaryLength;
  const summaryStyle = VALID_STYLES.includes(env.SUMMARY_STYLE as SummaryStyle)
    ? (env.SUMMARY_STYLE as SummaryStyle)
    : DEFAULTS.summaryStyle;
  const logLevel = VALID_LOG_LEVELS.includes(env.LOG_LEVEL as LogLevel)
    ? (env.LOG_LEVEL as LogLevel)
    : DEFAULTS.logLevel;

  const eventTypes = parseCsv(env.NOTION_EVENT_TYPES ?? DEFAULTS.notionEventTypes);

  return {
    notionVersion: env.NOTION_VERSION?.trim() || DEFAULTS.notionVersion,
    notionDatabaseId: env.NOTION_DATABASE_ID?.trim() || undefined,
    notionEventTypes: eventTypes.length > 0 ? eventTypes : parseCsv(DEFAULTS.notionEventTypes),
    summaryDelaySeconds: parsePositiveInt(env.SUMMARY_DELAY_SECONDS, DEFAULTS.summaryDelaySeconds),
    geminiModel: env.GEMINI_MODEL?.trim() || DEFAULTS.geminiModel,
    summaryLength,
    summaryStyle,
    notionPageSize: parsePositiveInt(env.NOTION_PAGE_SIZE, DEFAULTS.notionPageSize),
    notionMaxBlockFetches: parsePositiveInt(
      env.NOTION_MAX_BLOCK_FETCHES,
      DEFAULTS.notionMaxBlockFetches,
    ),
    notionMaxBlocks: parsePositiveInt(env.NOTION_MAX_BLOCKS, DEFAULTS.notionMaxBlocks),
    notionMaxMarkdownChars: parsePositiveInt(
      env.NOTION_MAX_MARKDOWN_CHARS,
      DEFAULTS.notionMaxMarkdownChars,
    ),
    debugVerbose: parseBool(env.DEBUG_VERBOSE, DEFAULTS.debugVerbose),
    logLevel,
    queueMaxRetries: parsePositiveInt(env.QUEUE_MAX_RETRIES, DEFAULTS.queueMaxRetries),
    notionApiToken: env.NOTION_API_TOKEN,
    notionWebhookToken: env.NOTION_WEBHOOK_TOKEN,
    geminiApiKey: env.GEMINI_API_KEY,
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackChannelIds: parseCsv(env.SLACK_SUMMARY_CHANNEL_ID),
  };
}

export { DEFAULTS };
