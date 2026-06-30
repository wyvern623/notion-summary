/**
 * 要約処理 (Cron 駆動・無料構成 / spec §7 を Cron+D1 へ移植)。
 *
 * Cron Trigger が定期実行され、`Db.getDuePages` で「debounce_until を過ぎた pending ページ」を
 * 拾い、各ページに対して本関数を呼ぶ。Queue は使わず、遅延・再試行は D1 で表現する。
 *
 * 1 ページの処理:
 *   - processing lock を取得 (取れなければ別実行が処理中 → 今回はスキップ、次 tick で再試行)
 *   - ページ再取得 → 現在の last_edited_time が D1 と異なれば newer_edit としてスキップ
 *   - 本文取得 → 空なら empty_body スキップ
 *   - Gemini 要約 (permanent エラーは Slack 投稿せず failed)
 *   - Slack 投稿 (チャンネル単位で冪等 / 一部失敗は retry)
 *   - 完了で completed
 *
 * retry 方針 (D1 retry_count ベース):
 *   notion retryable / gemini transient / slack 未完了 などの一時失敗は
 *   retry_count < maxRetries なら bumpRetry で pending に戻し (次 tick で再試行)、
 *   上限到達なら failed として記録する。
 */
import type { Db, PageStateRow } from "../db.js";
import { type GeminiClient, GeminiError, SUMMARY_ERROR_PREFIX } from "../services/gemini.js";
import { NotionApiError, type NotionClient } from "../services/notion.js";
import { type SlackClient, buildSummaryMessage } from "../services/slack.js";
import type { AppConfig } from "../types.js";
import type { Logger } from "../utils/logger.js";

export interface ProcessorDeps {
  config: AppConfig;
  db: Db;
  notion: NotionClient;
  gemini: GeminiClient;
  slack: SlackClient;
  now: () => Date;
  logger: Logger;
  maxRetries: number;
  lockTtlSeconds: number;
}

/** 一時失敗 (retry 対象) を表す内部エラー。 */
class RetryableError extends Error {}

/** Cron 1 回分: due なページを取得し、それぞれ処理する。 */
export async function processDuePages(deps: ProcessorDeps): Promise<void> {
  const nowIso = deps.now().toISOString();
  const pages = await deps.db.getDuePages(nowIso, deps.config.cronMaxPages);
  deps.logger.info("cron tick", { due_pages: pages.length });
  for (const page of pages) {
    await processDuePage(page, deps);
  }
}

/** 1 ページを要約処理する。lock 取得から完了/スキップ/失敗までを担う。 */
export async function processDuePage(state: PageStateRow, deps: ProcessorDeps): Promise<void> {
  const { db, notion, gemini, slack, config, logger } = deps;
  const pageId = state.page_id;
  const nowDate = deps.now();
  const nowIso = nowDate.toISOString();

  // processing lock。取得失敗なら別実行が処理中とみなし今回はスキップ (次 tick で再試行)。
  const lockUntil = new Date(nowDate.getTime() + deps.lockTtlSeconds * 1000).toISOString();
  const locked = await db.acquireLock({ pageId, now: nowIso, lockUntil });
  if (!locked) {
    logger.info("skip: lock held by another run", { page_id: pageId });
    return;
  }

  const jobId = (await db.getLatestJobByPage(pageId))?.id;
  let lockAcquired = true;
  try {
    if (jobId) {
      await db.updateJobStatus({ id: jobId, status: "processing", startedAt: nowIso, now: nowIso });
    }

    // ロック取得後に最新の行を読み直す。getDuePages のスナップショット以降に
    // 新しい Webhook が来て debounce_until が先送りされていたら、まだ編集中とみなしスキップ。
    const fresh = (await db.getPageState(pageId)) ?? state;
    if (Date.parse(fresh.debounce_until) > nowDate.getTime()) {
      await db.releaseLock(pageId, nowIso);
      lockAcquired = false;
      logger.info("skip: still_editing", { page_id: pageId });
      return;
    }

    // ページ取得 (ここで初めて Notion を叩く)。
    const info = await notion.getPageInfo(pageId);

    // 対象 DB フィルタ (Webhook から Cron へ移動)。
    if (config.notionDatabaseId) {
      if (normalizeId(info.parentDatabaseId) !== normalizeId(config.notionDatabaseId)) {
        await db.markPageStatus({ pageId, status: "skipped", now: nowIso });
        lockAcquired = false;
        await skipJob(deps, jobId, "other_database", nowIso);
        logger.info("skip: other_database", { page_id: pageId });
        return;
      }
    }

    // 重複防止: 前回要約した版と同じ last_edited_time なら、内容が変わっていない → スキップ。
    if (fresh.latest_last_edited_time && info.lastEditedTime === fresh.latest_last_edited_time) {
      await db.markPageStatus({ pageId, status: "completed", now: nowIso });
      lockAcquired = false;
      await skipJob(deps, jobId, "no_change", nowIso);
      logger.info("skip: no_change", { page_id: pageId });
      return;
    }

    // 本文取得 → 空ならスキップ。
    const content = await notion.getPageContent(pageId);
    if (content.markdown.trim().length === 0) {
      await db.markPageStatus({ pageId, status: "skipped", now: nowIso });
      lockAcquired = false;
      await skipJob(deps, jobId, "empty_body", nowIso);
      logger.info("skip: empty_body", { page_id: pageId });
      return;
    }

    // カテゴリ = 親 DB タイトル (取得失敗は致命的でない)。
    let category = "未分類";
    if (info.parentDatabaseId) {
      const title = await safe(() => notion.getDatabaseTitle(info.parentDatabaseId as string));
      if (title) category = title;
    }

    // Gemini 要約。transient は throw → 下の catch で retry。
    const summary = await gemini.summarize({
      title: info.title,
      category,
      markdown: content.markdown,
    });
    if (summary.startsWith(SUMMARY_ERROR_PREFIX)) {
      // permanent: Slack へ投稿せず failed (spec §20)。
      await failPage(deps, jobId, pageId, summary, nowIso);
      lockAcquired = false;
      return;
    }

    // Slack 投稿 (チャンネル単位の冪等化, 計画 §4-C)。
    const channels = config.slackChannelIds;
    if (channels.length === 0) {
      logger.error("no slack channel configured", { page_id: pageId });
      await failPage(deps, jobId, pageId, "no_slack_channel", nowIso);
      lockAcquired = false;
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
      // 未投稿チャンネルが残る → retry (次回は未投稿分のみ送る)。lock は catch で解放。
      throw new RetryableError("slack post incomplete");
    }

    // 完了確定。処理中に新しい Webhook で debounce_until が変わっていれば pending のまま残し、
    // 次の Cron で新しい編集を要約する (markPageCompleted 内の CASE で判定)。
    await db.markPageCompleted({
      pageId,
      lastEditedTime: info.lastEditedTime,
      summary,
      expectedDebounceUntil: fresh.debounce_until,
      now: nowIso,
    });
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
  } catch (error) {
    await handleFailure(error, deps, jobId, state, nowIso, lockAcquired);
  }
}

async function handleFailure(
  error: unknown,
  deps: ProcessorDeps,
  jobId: string | undefined,
  state: PageStateRow,
  nowIso: string,
  lockAcquired: boolean,
): Promise<void> {
  const pageId = state.page_id;
  if (lockAcquired) await safe(() => deps.db.releaseLock(pageId, nowIso));

  const retryable = isRetryable(error);
  const willRetry = retryable && state.retry_count + 1 < deps.maxRetries;
  if (willRetry) {
    deps.logger.warn("retrying page", {
      page_id: pageId,
      retry_count: state.retry_count,
      error: messageOf(error),
    });
    // pending に戻し retry_count++。次の Cron tick で再度 due として拾われる。
    await safe(() => deps.db.bumpRetry(pageId, nowIso, messageOf(error)));
    if (jobId) {
      await safe(() =>
        deps.db.updateJobStatus({
          id: jobId,
          status: "queued",
          retryCount: state.retry_count + 1,
          now: nowIso,
        }),
      );
    }
    return;
  }

  deps.logger.error("page failed", { page_id: pageId, error: messageOf(error) });
  await failPage(deps, jobId, pageId, messageOf(error), nowIso);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof NotionApiError) return error.retryable;
  if (error instanceof GeminiError) return error.kind === "transient";
  // 未知の例外 (ネットワーク等) は retry に回す。
  return true;
}

async function skipJob(
  deps: ProcessorDeps,
  jobId: string | undefined,
  reason: string,
  nowIso: string,
): Promise<void> {
  if (!jobId) return;
  await safe(() =>
    deps.db.updateJobStatus({ id: jobId, status: "skipped", skippedReason: reason, now: nowIso }),
  );
}

async function failPage(
  deps: ProcessorDeps,
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

/** Notion ID をダッシュ除去・小文字化して比較用に正規化する。 */
function normalizeId(id: string | undefined): string {
  return id ? id.replace(/-/g, "").toLowerCase() : "";
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
