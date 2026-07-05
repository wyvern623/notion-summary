/**
 * Worker entrypoint (無料構成: Cron + D1)。
 * - fetch: GET / (ヘルスチェック) と POST /notion/webhook を提供する。
 * - scheduled: Cron Trigger で due なページを拾い要約処理する (Queue の代替)。
 */
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { type ProcessorDeps, processDuePages } from "./handlers/consumer.js";
import { type WebhookDeps, handleWebhook } from "./handlers/webhook.js";
import { GeminiClient } from "./services/gemini.js";
import { NotionClient } from "./services/notion.js";
import { SlackClient } from "./services/slack.js";
import type { AppConfig, Env } from "./types.js";
import { createLogger } from "./utils/logger.js";

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const LOCK_TTL_SECONDS = 120;

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
        now: () => new Date(),
        uuid: () => crypto.randomUUID(),
        logger,
      };
      return handleWebhook(request, deps);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const config = loadConfig(env);
    const logger = createLogger(config.logLevel);
    const deps: ProcessorDeps = {
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
      now: () => new Date(),
      logger,
      maxRetries: config.summaryMaxRetries,
      lockTtlSeconds: LOCK_TTL_SECONDS,
    };
    ctx.waitUntil(processDuePages(deps));
  },
} satisfies ExportedHandler<Env>;
