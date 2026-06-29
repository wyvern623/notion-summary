/**
 * POST /notion/webhook ハンドラ (spec §6 / 計画 §4-A)。
 *
 * 重要な順序 (計画 §4-A):
 *   1. raw body を 1 回だけ読む (request.json() は使わない)。
 *   2. JSON parse。
 *   3. verification_token を含めば初回ハンドシェイクとして 200 (署名検証不要)。
 *   4. それ以外は署名必須。NOTION_WEBHOOK_TOKEN 未設定なら fail-closed で 500。
 *   5. 署名検証 → 対象判定 → ページ取得 → DB フィルタ → D1 upsert → Queue 投入。
 */
import type { Db } from "../db.js";
import type { NotionClient } from "../services/notion.js";
import type { AppConfig, SummaryJobMessage } from "../types.js";
import { verifyNotionSignature } from "../utils/crypto.js";
import type { Logger } from "../utils/logger.js";

export interface WebhookDeps {
  config: AppConfig;
  db: Db;
  notion: NotionClient;
  queue: Queue<SummaryJobMessage>;
  now: () => Date;
  uuid: () => string;
  logger: Logger;
}

export async function handleWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const { config, db, notion, queue, logger } = deps;

  // 1. raw body を 1 回だけ読む。
  const raw = await request.text();

  // 2. JSON parse。
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  // 3. 初回検証ハンドシェイク。
  if (typeof payload.verification_token === "string") {
    // setup 時に verification_token を回収するための意図的なログ (API キーではない)。
    logger.info("notion verification handshake", {
      verification_token: payload.verification_token,
    });
    return json({ ok: true }, 200);
  }

  // 4. 署名必須。未設定なら fail-closed。
  if (!config.notionWebhookToken) {
    logger.error("NOTION_WEBHOOK_TOKEN is not configured; rejecting webhook");
    return json({ error: "webhook_not_configured" }, 500);
  }
  const signatureValid = await verifyNotionSignature(
    config.notionWebhookToken,
    raw,
    request.headers.get("X-Notion-Signature"),
  );
  if (!signatureValid) {
    return json({ error: "invalid signature" }, 401);
  }

  // 5. 対象イベント判定。
  const eventType = typeof payload.type === "string" ? payload.type : "";
  if (!config.notionEventTypes.includes(eventType)) {
    return json({ ok: true, skipped: "event_type" }, 200);
  }

  const entity = asObject(payload.entity);
  if (entity?.type !== "page") {
    return json({ ok: true, skipped: "non_page" }, 200);
  }
  const pageId = typeof entity.id === "string" ? entity.id : "";
  if (!pageId) {
    return json({ ok: true, skipped: "no_page_id" }, 200);
  }

  // ページ取得。
  let pageInfo: Awaited<ReturnType<NotionClient["getPageInfo"]>>;
  try {
    pageInfo = await notion.getPageInfo(pageId);
  } catch (error) {
    logger.warn("page fetch failed", { page_id: pageId, error: messageOf(error) });
    return json({ ok: true, skipped: "page_fetch_failed" }, 200);
  }

  // 対象 DB フィルタ。
  if (config.notionDatabaseId) {
    if (normalizeId(pageInfo.parentDatabaseId) !== normalizeId(config.notionDatabaseId)) {
      return json({ ok: true, skipped: "other_database" }, 200);
    }
  }

  const nowDate = deps.now();
  const nowIso = nowDate.toISOString();
  const debounceUntil = new Date(
    nowDate.getTime() + config.summaryDelaySeconds * 1000,
  ).toISOString();
  const lastEditedTime = pageInfo.lastEditedTime;
  const jobId = deps.uuid();

  // D1 更新 (page_state upsert + summary_jobs 履歴)。
  try {
    await db.upsertPageState({
      pageId,
      latestLastEditedTime: lastEditedTime,
      debounceUntil,
      now: nowIso,
    });
    await db.insertJob({
      id: jobId,
      pageId,
      eventType,
      payloadLastEditedTime: lastEditedTime,
      status: "queued",
      queuedAt: nowIso,
      now: nowIso,
    });
  } catch (error) {
    logger.error("db update failed", { page_id: pageId, error: messageOf(error) });
    return json({ error: "db_error" }, 500);
  }

  // Queue 投入 (delaySeconds 付き)。
  const message: SummaryJobMessage = {
    job_id: jobId,
    page_id: pageId,
    event_type: eventType,
    last_edited_time: lastEditedTime,
    queued_at: nowIso,
  };
  try {
    await queue.send(message, { delaySeconds: config.summaryDelaySeconds });
  } catch (error) {
    logger.error("queue send failed", { page_id: pageId, error: messageOf(error) });
    return json({ error: "queue_error" }, 500);
  }

  logger.info("webhook queued", { job_id: jobId, page_id: pageId, event_type: eventType });
  return json({ ok: true }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeId(id: string | undefined): string {
  return id ? id.replace(/-/g, "").toLowerCase() : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
