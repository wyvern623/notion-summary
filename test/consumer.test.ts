import { describe, expect, it } from "vitest";
import { Db, type PageStateRow } from "../src/db.js";
import {
  type ProcessorDeps,
  formatJst,
  processDuePage,
  processDuePages,
} from "../src/handlers/consumer.js";
import { GeminiClient } from "../src/services/gemini.js";
import { NotionClient } from "../src/services/notion.js";
import { SlackClient } from "../src/services/slack.js";
import { createLogger } from "../src/utils/logger.js";
import { FakeD1 } from "./helpers/fakeD1.js";
import { type Route, createFetchMock } from "./helpers/fetchMock.js";

const PAGE_ID = "page-1";
const LET = "2026-06-06T09:59:00.000Z"; // Notion が返す現在の last_edited_time
const NOW = new Date("2026-06-06T10:11:00.000Z"); // debounce 後

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
const SLACK_OK: Route = {
  match: (u) => u.includes("chat.postMessage"),
  responses: [{ body: { ok: true, ts: "1.1" } }],
};

interface Ctx {
  fake: FakeD1;
  db: Db;
  deps: ProcessorDeps;
}

function buildCtx(options: {
  routes: Route[];
  channels?: string[];
  now?: Date;
  notionDatabaseId?: string;
}): Ctx {
  const fetchImpl = createFetchMock(options.routes) as typeof fetch;
  const fake = new FakeD1();
  const db = new Db(fake.asD1());
  const deps: ProcessorDeps = {
    config: {
      notionVersion: "2022-06-28",
      notionDatabaseId: options.notionDatabaseId,
      notionEventTypes: ["page.content_updated"],
      summaryDelaySeconds: 600,
      summaryMinIntervalSeconds: 1800,
      geminiModel: "gemini-2.5-flash-lite",
      summaryLength: "medium",
      summaryStyle: "bullet",
      notionPageSize: 100,
      notionMaxBlockFetches: 30,
      notionMaxBlocks: 800,
      notionMaxMarkdownChars: 30000,
      debugVerbose: false,
      logLevel: "ERROR",
      summaryMaxRetries: 3,
      cronMaxPages: 3,
      slackChannelIds: options.channels ?? ["C1"],
    },
    db,
    notion: new NotionClient({
      token: "n",
      notionVersion: "2022-06-28",
      pageSize: 100,
      maxBlockFetches: 30,
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
    now: () => options.now ?? NOW,
    logger: createLogger("ERROR"),
    maxRetries: 3,
    lockTtlSeconds: 120,
  };
  return { fake, db, deps };
}

function seedState(
  fake: FakeD1,
  overrides: Partial<{
    pageId: string;
    latest: string;
    debounceUntil: string;
    lockUntil: string | null;
    slackTs: string | null;
    retryCount: number;
  }> = {},
): PageStateRow {
  const row: PageStateRow = {
    page_id: overrides.pageId ?? PAGE_ID,
    // latest = 「前回要約した版」。デフォルトは空 (未要約) なので要約対象になる。
    latest_last_edited_time: overrides.latest ?? "",
    debounce_until: overrides.debounceUntil ?? "2026-06-06T10:10:00.000Z", // 過去 = due
    status: "pending",
    lock_until: overrides.lockUntil ?? null,
    last_summarized_at: null,
    last_summary: null,
    slack_ts: overrides.slackTs ?? null,
    retry_count: overrides.retryCount ?? 0,
    error_message: null,
    created_at: "x",
    updated_at: "x",
  };
  fake.pageStates.set(row.page_id, row);
  return row;
}

describe("formatJst", () => {
  it("UTC を JST へ変換する", () => {
    expect(formatJst("2026-06-06T09:59:00.000Z")).toBe("2026-06-06 18:59 JST");
  });
});

describe("processDuePages (Cron tick)", () => {
  it("due なページだけ処理する", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK, SLACK_OK] });
    seedState(ctx.fake); // due
    seedState(ctx.fake, { pageId: "page-2", debounceUntil: "2026-06-06T23:00:00.000Z" }); // not due
    await processDuePages(ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("completed");
    expect(ctx.fake.pageStates.get("page-2")?.status).toBe("pending");
  });
});

describe("lock 競合", () => {
  it("ロック取得失敗なら何もしない", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK, SLACK_OK] });
    const state = seedState(ctx.fake, { lockUntil: "2026-06-06T10:12:00.000Z" });
    await processDuePage(state, ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).not.toBe("completed");
    expect(ctx.fake.pageStates.get(PAGE_ID)?.slack_ts).toBeNull();
  });
});

describe("still_editing スキップ", () => {
  it("ロック後の再読み込みで debounce_until が未来なら処理しない", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK, SLACK_OK] });
    const state = seedState(ctx.fake, { debounceUntil: "2026-06-06T10:20:00.000Z" }); // now より後
    await processDuePage(state, ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).not.toBe("completed");
  });
});

describe("no_change スキップ (重複防止)", () => {
  it("前回要約した版と現在の last_edited_time が同じなら Slack 投稿しない", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK, SLACK_OK] });
    const state = seedState(ctx.fake, { latest: LET }); // = Notion の現在値
    await processDuePage(state, ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.slack_ts).toBeNull();
    expect(row?.status).toBe("completed"); // 既に要約済み版なので completed のまま
  });
});

describe("対象 DB フィルタ (Cron 側)", () => {
  it("親 DB が NOTION_DATABASE_ID と異なれば other_database でスキップ", async () => {
    const ctx = buildCtx({
      routes: [PAGE_ROUTE, BLOCKS_ROUTE, GEMINI_OK, SLACK_OK],
      notionDatabaseId: "db-OTHER",
    });
    const state = seedState(ctx.fake);
    await processDuePage(state, ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("skipped");
    expect(ctx.fake.pageStates.get(PAGE_ID)?.slack_ts).toBeNull();
  });
});

describe("正常系", () => {
  it("要約して Slack 投稿し completed、版を記録する", async () => {
    const ctx = buildCtx({ routes: [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK, SLACK_OK] });
    const state = seedState(ctx.fake);
    await processDuePage(state, ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("completed");
    expect(row?.last_summary).toBe("要約結果");
    expect(row?.latest_last_edited_time).toBe(LET); // 要約した版を記録
    expect(JSON.parse(row?.slack_ts ?? "{}")).toEqual({ C1: "1.1" });
  });

  it("本文が空なら skipped", async () => {
    const emptyBlocks: Route = {
      match: (u) => u.includes("/children"),
      responses: [{ body: { results: [], has_more: false, next_cursor: null } }],
    };
    const ctx = buildCtx({ routes: [PAGE_ROUTE, emptyBlocks] });
    const state = seedState(ctx.fake);
    await processDuePage(state, ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("skipped");
  });
});

describe("Slack 冪等性", () => {
  it("一部チャンネル失敗で retry(pending)、成功分は再送しない", async () => {
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
            { body: { ok: true, ts: "1.1" } },
            { body: { ok: false, error: "channel_error" } },
          ],
        },
      ],
    });
    const state = seedState(ctx.fake);
    await processDuePage(state, ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("pending");
    expect(row?.retry_count).toBe(1);
    expect(JSON.parse(row?.slack_ts ?? "{}")).toEqual({ C1: "1.1" });
  });
});

describe("Gemini エラー", () => {
  it("transient(429) は retry(pending, retry_count++)", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        { match: (u) => u.includes(":generateContent"), responses: [{ status: 429, body: {} }] },
      ],
    });
    const state = seedState(ctx.fake);
    await processDuePage(state, ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("pending");
    expect(row?.retry_count).toBe(1);
    expect(row?.lock_until).toBeNull();
  });

  it("retry 上限到達なら failed", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        { match: (u) => u.includes(":generateContent"), responses: [{ status: 503, body: {} }] },
      ],
    });
    const state = seedState(ctx.fake, { retryCount: 2 });
    await processDuePage(state, ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("failed");
  });

  it("permanent(モデル不可) は Slack 投稿せず failed", async () => {
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
    const state = seedState(ctx.fake);
    await processDuePage(state, ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("failed");
    expect(row?.slack_ts).toBeNull();
  });
});
