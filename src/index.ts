/**
 * Worker entrypoint。
 * - fetch: GET / (ヘルスチェック) と POST /notion/webhook を提供する。
 * - queue: 要約ジョブの consumer (Step 11 で実装)。
 */
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { type ConsumerDeps, processMessage } from "./handlers/consumer.js";
import { type WebhookDeps, handleWebhook } from "./handlers/webhook.js";
import { GeminiClient } from "./services/gemini.js";
import { NotionClient } from "./services/notion.js";
import { SlackClient } from "./services/slack.js";
import type { AppConfig, Env, SummaryJobMessage } from "./types.js";
import { createLogger } from "./utils/logger.js";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const LOCK_TTL_SECONDS = 120;
const LOCK_RETRY_DELAY_SECONDS = 15;

function buildNotionClient(config: AppConfig): NotionClient {
  return new NotionClient({
    token: config.notionApiToken ?? "",
    notionVersion: config.notionVersion,
    pageSize: config.notionPageSize,
    maxBlockFetches: config.notionMaxBlockFetches,
    maxBlocks: config.notionMaxBlocks,
    maxMarkdownChars: config.notionMaxMarkdownChars,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const logger = createLogger(config.logLevel);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/notion/webhook") {
      const deps: WebhookDeps = {
        config,
        db: new Db(env.DB),
        notion: buildNotionClient(config),
        queue: env.SUMMARY_QUEUE,
        now: () => new Date(),
        uuid: () => crypto.randomUUID(),
        logger,
      };
      return handleWebhook(request, deps);
    }

    return new Response("not found", { status: 404 });
  },

  async queue(batch: MessageBatch<SummaryJobMessage>, env: Env): Promise<void> {
    const config = loadConfig(env);
    const logger = createLogger(config.logLevel);
    const deps: ConsumerDeps = {
      config,
      db: new Db(env.DB),
      notion: buildNotionClient(config),
      gemini: new GeminiClient({
        apiKey: config.geminiApiKey ?? "",
        model: config.geminiModel,
        defaultModel: DEFAULT_GEMINI_MODEL,
        length: config.summaryLength,
        style: config.summaryStyle,
      }),
      slack: new SlackClient(config.slackBotToken ?? ""),
      queue: env.SUMMARY_QUEUE,
      now: () => new Date(),
      logger,
      maxRetries: config.queueMaxRetries,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      lockRetryDelaySeconds: LOCK_RETRY_DELAY_SECONDS,
    };
    for (const message of batch.messages) {
      await processMessage(message, deps);
    }
  },
} satisfies ExportedHandler<Env, SummaryJobMessage>;
