/**
 * Queue Consumer (spec §7 / 計画 §4-B, §4-C)。
 *
 * 1 メッセージ = 1 要約ジョブ。冪等性と retry を D1 + message.attempts で担保する。
 *
 * 主な分岐:
 *   - page_id なし          → job failed, ack
 *   - newer_edit            → job skipped, ack (page_state は新しいジョブが所有するので触らない)
 *   - debounce 中           → 残り秒数 delay で再 Queue 投入, ack
 *   - lock 取得失敗          → 短時間 delay で再 Queue 投入, ack
 *   - 取得後 newer_edit      → skipped
 *   - 本文が空              → skipped empty_body
 *   - Gemini permanent      → failed (Slack 投稿しない)
 *   - Slack 一部失敗        → retryable (未投稿チャンネルだけ次回投稿)
 *   - 完了                  → completed
 *
 * retry 方針 (§4-B): notion retryable / gemini transient / slack 未完了 は
 *   message.attempts < maxRetries なら message.retry()、最終試行なら failed を記録して ack。
 */
import type { Db } from "../db.js";
import { type GeminiClient, SUMMARY_ERROR_PREFIX } from "../services/gemini.js";
import { GeminiError } from "../services/gemini.js";
import { NotionApiError, type NotionClient } from "../services/notion.js";
import { type SlackClient, buildSummaryMessage } from "../services/slack.js";
import type { AppConfig, SummaryJobMessage } from "../types.js";
import type { Logger } from "../utils/logger.js";

/** Queue の Message から本実装が使う部分だけを抜き出した最小インターフェース。 */
export interface QueueMessageLike<T> {
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumerDeps {
  config: AppConfig;
  db: Db;
  notion: NotionClient;
  gemini: GeminiClient;
  slack: SlackClient;
  /** debounce / lock 競合時の再投入先 (producer binding)。 */
  queue: Queue<SummaryJobMessage>;
  now: () => Date;
  logger: Logger;
  maxRetries: number;
  lockTtlSeconds: number;
  lockRetryDelaySeconds: number;
}

/** lock 解放後に通常の retry に乗せたい失敗を表す内部エラー。 */
class RetryableError extends Error {}

export async function processMessage(
  msg: QueueMessageLike<SummaryJobMessage>,
  deps: ConsumerDeps,
): Promise<void> {
  const { db, notion, gemini, slack, config, logger } = deps;
  const payload = msg.body;
  const nowDate = deps.now();
  const nowIso = nowDate.toISOString();

  const pageId = payload?.page_id;
  const jobId = payload?.job_id;

  // page_id なし → 失敗として ack。
  if (!pageId) {
    logger.warn("queue message without page_id");
    if (jobId) {
      await safe(() =>
        db.updateJobStatus({
          id: jobId,
          status: "failed",
          errorMessage: "no_page_id",
          now: nowIso,
        }),
      );
    }
    msg.ack();
    return;
  }

  let lockAcquired = false;
  try {
    if (jobId) {
      await db.updateJobStatus({ id: jobId, status: "processing", startedAt: nowIso, now: nowIso });
    }

    const state = await db.getPageState(pageId);
    if (!state) {
      logger.warn("no page_state for job", { page_id: pageId });
      await skipJob(deps, jobId, "no_state", nowIso);
      msg.ack();
      return;
    }

    // newer_edit (lock 取得前)。page_state は新しいジョブが所有するので触らない。
    if (state.latest_last_edited_time !== payload.last_edited_time) {
      await skipJob(deps, jobId, "newer_edit", nowIso);
      msg.ack();
      return;
    }

    // debounce 中 → 残り秒数で再投入。attempts を消費しないよう新規 send + ack。
    const debounceUntilMs = Date.parse(state.debounce_until);
    if (Number.isFinite(debounceUntilMs) && nowDate.getTime() < debounceUntilMs) {
      const delaySeconds = Math.max(1, Math.ceil((debounceUntilMs - nowDate.getTime()) / 1000));
      await deps.queue.send(payload, { delaySeconds });
      if (jobId) await db.updateJobStatus({ id: jobId, status: "queued", now: nowIso });
      logger.info("requeued for debounce", { page_id: pageId, delaySeconds });
      msg.ack();
      return;
    }

    // processing lock。失敗時は別 consumer が処理中とみなし短時間 delay で再投入。
    const lockUntil = new Date(nowDate.getTime() + deps.lockTtlSeconds * 1000).toISOString();
    lockAcquired = await db.acquireLock({ pageId, now: nowIso, lockUntil });
    if (!lockAcquired) {
      await deps.queue.send(payload, { delaySeconds: deps.lockRetryDelaySeconds });
      logger.info("requeued for lock contention", { page_id: pageId });
      msg.ack();
      return;
    }

    // ページ再取得 + 現在の last_edited_time 比較。
    const info = await notion.getPageInfo(pageId);
    if (info.lastEditedTime !== payload.last_edited_time) {
      await db.releaseLock(pageId, nowIso);
      lockAcquired = false;
      await skipJob(deps, jobId, "newer_edit", nowIso);
      msg.ack();
      return;
    }

    // 本文取得 → 空ならスキップ。
    const content = await notion.getPageContent(pageId);
    if (content.markdown.trim().length === 0) {
      await db.releaseLock(pageId, nowIso);
      lockAcquired = false;
      await skipJob(deps, jobId, "empty_body", nowIso);
      msg.ack();
      return;
    }

    // カテゴリ = 親 DB タイトル (取得失敗は致命的でない)。
    let category = "未分類";
    if (info.parentDatabaseId) {
      const title = await safe(() => notion.getDatabaseTitle(info.parentDatabaseId as string));
      if (title) category = title;
    }

    // Gemini 要約。transient は throw され下の catch で retry。
    const summary = await gemini.summarize({ title: info.title, markdown: content.markdown });
    if (summary.startsWith(SUMMARY_ERROR_PREFIX)) {
      // permanent: Slack へ投稿せず failed (spec §20)。
      await failJob(deps, jobId, pageId, summary, nowIso);
      lockAcquired = false;
      msg.ack();
      return;
    }

    // Slack 投稿 (チャンネル単位の冪等化, §4-C)。
    const channels = config.slackChannelIds;
    if (channels.length === 0) {
      logger.error("no slack channel configured", { page_id: pageId });
      await failJob(deps, jobId, pageId, "no_slack_channel", nowIso);
      lockAcquired = false;
      msg.ack();
      return;
    }

    const already = await db.getPostedChannels(pageId);
    const targets = channels.filter((c) => !already[c]);
    const message = buildSummaryMessage({
      title: info.title,
      category,
      updatedAt: formatJst(info.lastEditedTime),
      summaryMarkdown: summary,
      url: info.url,
    });
    const results = targets.length > 0 ? await slack.postToChannels(targets, message) : [];
    const posted: Record<string, string> = {};
    for (const r of results) {
      if (r.ok && r.ts) posted[r.channel] = r.ts;
      else if (!r.ok) logger.warn("slack post failed", { page_id: pageId, error: r.error });
    }
    if (Object.keys(posted).length > 0) {
      await db.addPostedChannels({ pageId, posted, now: nowIso });
    }

    const successful = { ...already, ...posted };
    const allPosted = channels.every((c) => successful[c]);
    if (!allPosted) {
      // 一部チャンネル未投稿 → retry (未投稿分は次回送る)。lock は catch で解放。
      throw new RetryableError("slack post incomplete");
    }

    await db.markPageCompleted({ pageId, summary, now: nowIso });
    lockAcquired = false;
    if (jobId) {
      await db.updateJobStatus({
        id: jobId,
        status: "completed",
        completedAt: nowIso,
        now: nowIso,
      });
    }
    logger.info("summary completed", { job_id: jobId, page_id: pageId });
    msg.ack();
  } catch (error) {
    await handleFailure(error, msg, deps, jobId, pageId, nowIso, lockAcquired);
  }
}

async function handleFailure(
  error: unknown,
  msg: QueueMessageLike<SummaryJobMessage>,
  deps: ConsumerDeps,
  jobId: string | undefined,
  pageId: string,
  nowIso: string,
  lockAcquired: boolean,
): Promise<void> {
  // lock を解放して次の試行で再取得できるようにする。
  if (lockAcquired) await safe(() => deps.db.releaseLock(pageId, nowIso));

  const retryable = isRetryable(error);
  if (retryable && msg.attempts < deps.maxRetries) {
    deps.logger.warn("retrying job", {
      job_id: jobId,
      page_id: pageId,
      attempts: msg.attempts,
      error: messageOf(error),
    });
    if (jobId) {
      await safe(() =>
        deps.db.updateJobStatus({
          id: jobId,
          status: "queued",
          retryCount: msg.attempts,
          now: nowIso,
        }),
      );
    }
    msg.retry();
    return;
  }

  // 最終試行 or 非 retryable → failed を確実に記録してから ack (§4-B)。
  deps.logger.error("job failed", { job_id: jobId, page_id: pageId, error: messageOf(error) });
  await failJob(deps, jobId, pageId, messageOf(error), nowIso);
  msg.ack();
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof NotionApiError) return error.retryable;
  if (error instanceof GeminiError) return error.kind === "transient";
  // 未知の例外 (ネットワーク等) は retry に回す。
  return true;
}

async function skipJob(
  deps: ConsumerDeps,
  jobId: string | undefined,
  reason: string,
  nowIso: string,
): Promise<void> {
  if (!jobId) return;
  await safe(() =>
    deps.db.updateJobStatus({ id: jobId, status: "skipped", skippedReason: reason, now: nowIso }),
  );
}

async function failJob(
  deps: ConsumerDeps,
  jobId: string | undefined,
  pageId: string,
  errorMessage: string,
  nowIso: string,
): Promise<void> {
  await safe(() => deps.db.markPageStatus({ pageId, status: "failed", errorMessage, now: nowIso }));
  if (jobId) {
    await safe(() =>
      deps.db.updateJobStatus({
        id: jobId,
        status: "failed",
        errorMessage,
        completedAt: nowIso,
        now: nowIso,
      }),
    );
  }
}

/** 補助処理の失敗で全体を巻き込まないための握り (致命的でない箇所のみ使用)。 */
async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ISO 文字列を JST の "YYYY-MM-DD HH:mm JST" へ整形する。 */
export function formatJst(iso: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const jst = new Date(ms + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())} JST`;
}
