import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { type ConsumerDeps, formatJst, processMessage } from "../src/handlers/consumer.js";
import { GeminiClient } from "../src/services/gemini.js";
import { NotionClient } from "../src/services/notion.js";
import { SlackClient } from "../src/services/slack.js";
import type { SummaryJobMessage } from "../src/types.js";
import { createLogger } from "../src/utils/logger.js";
import { FakeD1 } from "./helpers/fakeD1.js";
import { FakeMessage } from "./helpers/fakeMessage.js";
import { FakeQueue } from "./helpers/fakeQueue.js";
import { type Route, createFetchMock } from "./helpers/fetchMock.js";

const PAGE_ID = "page-1";
const LET = "2026-06-06T09:59:00.000Z"; // last_edited_time
const NOW = new Date("2026-06-06T10:11:00.000Z"); // debounce 後

function payload(overrides: Partial<SummaryJobMessage> = {}): SummaryJobMessage {
  return {
    job_id: "job-1",
    page_id: PAGE_ID,
    event_type: "page.content_updated",
    last_edited_time: LET,
    queued_at: "2026-06-06T10:00:05.000Z",
    ...overrides,
  };
}

const PAGE_ROUTE: Route = {
  match: (u) => u.includes("/v1/pages/"),
  responses: [
    {
      body: {
        id: PAGE_ID,
        url: "https://notion.so/page-1",
        last_edited_time: LET,
        parent: { type: "database_id", database_id: "db-1" },
        properties: { Name: { type: "title", title: [{ plain_text: "研究ノート" }] } },
      },
    },
  ],
};
const DB_ROUTE: Route = {
  match: (u) => u.includes("/v1/databases/"),
  responses: [{ body: { title: [{ plain_text: "研究DB" }] } }],
};
const BLOCKS_ROUTE: Route = {
  match: (u) => u.includes("/children"),
  responses: [
    {
      body: {
        results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "本文あり" }] } }],
        has_more: false,
        next_cursor: null,
      },
    },
  ],
};
const GEMINI_OK: Route = {
  match: (u) => u.includes(":generateContent"),
  responses: [{ body: { candidates: [{ content: { parts: [{ text: "要約結果" }] } }] } }],
};

interface Ctx {
  fake: FakeD1;
  db: Db;
  queue: FakeQueue<SummaryJobMessage>;
  deps: ConsumerDeps;
}

function buildCtx(options: {
  routes: Route[];
  channels?: string[];
  now?: Date;
}): Ctx {
  const fetchImpl = createFetchMock(options.routes) as typeof fetch;
  const fake = new FakeD1();
  const db = new Db(fake.asD1());
  const queue = new FakeQueue<SummaryJobMessage>();
  const deps: ConsumerDeps = {
    config: {
      notionVersion: "2022-06-28",
      notionEventTypes: ["page.content_updated"],
      summaryDelaySeconds: 600,
      geminiModel: "gemini-2.5-flash-lite",
      summaryLength: "medium",
      summaryStyle: "bullet",
      notionPageSize: 100,
      notionMaxBlockFetches: 40,
      notionMaxBlocks: 800,
      notionMaxMarkdownChars: 30000,
      debugVerbose: false,
      logLevel: "ERROR",
      queueMaxRetries: 3,
      slackChannelIds: options.channels ?? ["C1"],
    },
    db,
    notion: new NotionClient({
      token: "n",
      notionVersion: "2022-06-28",
      pageSize: 100,
      maxBlockFetches: 40,
      maxBlocks: 800,
      maxMarkdownChars: 30000,
      fetchImpl,
    }),
    gemini: new GeminiClient({
      apiKey: "k",
      model: "gemini-2.5-flash-lite",
      defaultModel: "gemini-2.5-flash-lite",
      length: "medium",
      style: "bullet",
      fetchImpl,
    }),
    slack: new SlackClient("t", fetchImpl),
    queue: queue.asQueue(),
    now: () => options.now ?? NOW,
    logger: createLogger("ERROR"),
    maxRetries: 3,
    lockTtlSeconds: 120,
    lockRetryDelaySeconds: 15,
  };
  return { fake, db, queue, deps };
}

function seedState(
  fake: FakeD1,
  overrides: Partial<{
    latest: string;
    debounceUntil: string;
    lockUntil: string | null;
    slackTs: string | null;
  }> = {},
): void {
  fake.pageStates.set(PAGE_ID, {
    page_id: PAGE_ID,
    latest_last_edited_time: overrides.latest ?? LET,
    debounce_until: overrides.debounceUntil ?? "2026-06-06T10:10:00.000Z", // 過去
    status: "pending",
    lock_until: overrides.lockUntil ?? null,
    last_summarized_at: null,
    last_summary: null,
    slack_ts: overrides.slackTs ?? null,
    retry_count: 0,
    error_message: null,
    created_at: "x",
    updated_at: "x",
  });
}

describe("formatJst", () => {
  it("UTC を JST へ変換する", () => {
    expect(formatJst("2026-06-06T09:59:00.000Z")).toBe("2026-06-06 18:59 JST");
  });
});

describe("newer_edit スキップ", () => {
  it("payload と D1 の last_edited_time が異なれば Slack 投稿しない", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK] });
    seedState(ctx.fake, { latest: "2026-06-06T10:30:00.000Z" }); // payload より新しい
    const msg = new FakeMessage(payload());
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    expect(ctx.fake.jobs.get("job-1")).toBeUndefined(); // updateJobStatus は insert しない
    expect(ctx.queue.sent).toHaveLength(0);
  });
});

describe("debounce 中の再投入", () => {
  it("debounce_until より前なら残り秒数 delay で再 Queue", async () => {
    const ctx = buildCtx({
      routes: [PAGE_ROUTE],
      now: new Date("2026-06-06T10:05:00.000Z"),
    });
    seedState(ctx.fake, { debounceUntil: "2026-06-06T10:10:00.000Z" });
    const msg = new FakeMessage(payload());
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    expect(ctx.queue.sent).toHaveLength(1);
    expect(ctx.queue.sent[0].options?.delaySeconds).toBe(300);
  });
});

describe("lock 競合", () => {
  it("ロック取得失敗なら短時間 delay で再投入し二重投稿しない", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK] });
    // 既に未失効ロックが存在 (now=10:11 < lock_until=10:12)
    seedState(ctx.fake, { lockUntil: "2026-06-06T10:12:00.000Z" });
    const msg = new FakeMessage(payload());
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    expect(ctx.queue.sent).toHaveLength(1);
    expect(ctx.queue.sent[0].options?.delaySeconds).toBe(15);
  });
});

describe("正常系", () => {
  it("要約して Slack 投稿し completed にする", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        GEMINI_OK,
        {
          match: (u) => u.includes("chat.postMessage"),
          responses: [{ body: { ok: true, ts: "1.1" } }],
        },
      ],
    });
    seedState(ctx.fake);
    const msg = new FakeMessage(payload());
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    const state = ctx.fake.pageStates.get(PAGE_ID);
    expect(state?.status).toBe("completed");
    expect(state?.last_summary).toBe("要約結果");
    expect(JSON.parse(state?.slack_ts ?? "{}")).toEqual({ C1: "1.1" });
  });

  it("本文が空なら empty_body でスキップ", async () => {
    const emptyBlocks: Route = {
      match: (u) => u.includes("/children"),
      responses: [{ body: { results: [], has_more: false, next_cursor: null } }],
    };
    const ctx = buildCtx({ routes: [PAGE_ROUTE, emptyBlocks] });
    seedState(ctx.fake);
    const msg = new FakeMessage(payload());
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).not.toBe("completed");
  });
});

describe("Slack 冪等性", () => {
  it("一部チャンネル失敗で retry、成功分は再送しない", async () => {
    const ctx = buildCtx({
      channels: ["C1", "C2"],
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        GEMINI_OK,
        {
          match: (u) => u.includes("chat.postMessage"),
          responses: [
            { body: { ok: true, ts: "1.1" } }, // C1 成功
            { body: { ok: false, error: "channel_error" } }, // C2 失敗
          ],
        },
      ],
    });
    seedState(ctx.fake);
    const msg = new FakeMessage(payload(), 1);
    await processMessage(msg, ctx.deps);
    // 未完了 → retry
    expect(msg.retried).toBe(true);
    expect(msg.acked).toBe(false);
    // 成功した C1 は記録済み (次回再送しない)
    expect(JSON.parse(ctx.fake.pageStates.get(PAGE_ID)?.slack_ts ?? "{}")).toEqual({ C1: "1.1" });
  });
});

describe("Gemini エラー", () => {
  it("transient (429) は retry される (attempts<max)", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        { match: (u) => u.includes(":generateContent"), responses: [{ status: 429, body: {} }] },
      ],
    });
    seedState(ctx.fake);
    const msg = new FakeMessage(payload(), 1);
    await processMessage(msg, ctx.deps);
    expect(msg.retried).toBe(true);
    expect(msg.acked).toBe(false);
    // lock は解放されている
    expect(ctx.fake.pageStates.get(PAGE_ID)?.lock_until).toBeNull();
  });

  it("最大リトライ到達時は failed を記録して ack", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        { match: (u) => u.includes(":generateContent"), responses: [{ status: 503, body: {} }] },
      ],
    });
    seedState(ctx.fake);
    const msg = new FakeMessage(payload(), 3); // attempts == maxRetries
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("failed");
  });

  it("permanent (モデル不可) は Slack 投稿せず failed", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        {
          match: (u) => u.includes(":generateContent"),
          responses: [{ status: 404, body: { error: { message: "model not found" } } }],
        },
      ],
    });
    seedState(ctx.fake);
    const msg = new FakeMessage(payload());
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("failed");
    expect(ctx.fake.pageStates.get(PAGE_ID)?.slack_ts).toBeNull(); // 投稿していない
  });
});

describe("page_id なし", () => {
  it("failed として ack する", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE] });
    const msg = new FakeMessage(payload({ page_id: "" }));
    await processMessage(msg, ctx.deps);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
  });
});
