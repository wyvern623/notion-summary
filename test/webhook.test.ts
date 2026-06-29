import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { type WebhookDeps, handleWebhook } from "../src/handlers/webhook.js";
import { NotionClient } from "../src/services/notion.js";
import type { Env, SummaryJobMessage } from "../src/types.js";
import { computeHmacSha256Hex } from "../src/utils/crypto.js";
import { createLogger } from "../src/utils/logger.js";
import { FakeD1 } from "./helpers/fakeD1.js";
import { FakeQueue } from "./helpers/fakeQueue.js";
import { type Route, createFetchMock } from "./helpers/fetchMock.js";

const TOKEN = "whsec";
const NOW = new Date("2026-06-06T10:00:05.000Z");

interface Ctx {
  fake: FakeD1;
  queue: FakeQueue<SummaryJobMessage>;
  deps: WebhookDeps;
}

function buildCtx(options: {
  envOverrides?: Partial<Env>;
  notionRoutes?: Route[];
}): Ctx {
  const env = {
    DB: {} as Env["DB"],
    SUMMARY_QUEUE: {} as Env["SUMMARY_QUEUE"],
    NOTION_WEBHOOK_TOKEN: TOKEN,
    NOTION_API_TOKEN: "notion",
    SUMMARY_DELAY_SECONDS: "600",
    ...options.envOverrides,
  } as Env;
  const config = loadConfig(env);

  const fake = new FakeD1();
  const queue = new FakeQueue<SummaryJobMessage>();
  const notion = new NotionClient({
    token: "notion",
    notionVersion: config.notionVersion,
    pageSize: 100,
    maxBlockFetches: 40,
    maxBlocks: 800,
    maxMarkdownChars: 30000,
    fetchImpl: options.notionRoutes
      ? createFetchMock(options.notionRoutes)
      : (createFetchMock([
          { match: () => true, responses: [{ status: 500, body: {} }] },
        ]) as typeof fetch),
  });

  const deps: WebhookDeps = {
    config,
    db: new Db(fake.asD1()),
    notion,
    queue: queue.asQueue(),
    now: () => NOW,
    uuid: () => "job-fixed",
    logger: createLogger("ERROR"),
  };
  return { fake, queue, deps };
}

function pageRoute(body: Record<string, unknown>): Route {
  return { match: (u) => u.includes("/v1/pages/"), responses: [{ body }] };
}

async function makeRequest(payload: unknown, opts: { sign?: boolean } = {}): Promise<Request> {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.sign) {
    headers["X-Notion-Signature"] = `sha256=${await computeHmacSha256Hex(TOKEN, raw)}`;
  }
  return new Request("https://worker/notion/webhook", { method: "POST", body: raw, headers });
}

const VALID_EVENT = {
  type: "page.content_updated",
  entity: { type: "page", id: "page-1" },
};

const PAGE_BODY = {
  id: "page-1",
  url: "https://notion.so/page-1",
  last_edited_time: "2026-06-06T09:59:00.000Z",
  parent: { type: "database_id", database_id: "db-1" },
  properties: { Name: { type: "title", title: [{ plain_text: "T" }] } },
};

describe("入力検証", () => {
  it("JSON 不正は 400", async () => {
    const { deps } = buildCtx({});
    const req = new Request("https://worker/notion/webhook", { method: "POST", body: "{not json" });
    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid json" });
  });

  it("verification_token は 200 {ok:true} (署名不要)", async () => {
    const { deps } = buildCtx({});
    const res = await handleWebhook(await makeRequest({ verification_token: "tok" }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("署名検証 (fail-closed)", () => {
  it("NOTION_WEBHOOK_TOKEN 未設定の通常イベントは 500 (fail-closed)", async () => {
    const { deps } = buildCtx({ envOverrides: { NOTION_WEBHOOK_TOKEN: undefined } });
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: false }), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "webhook_not_configured" });
  });

  it("署名不一致は 401", async () => {
    const { deps } = buildCtx({});
    const raw = JSON.stringify(VALID_EVENT);
    const req = new Request("https://worker/notion/webhook", {
      method: "POST",
      body: raw,
      headers: { "X-Notion-Signature": "sha256=deadbeef" },
    });
    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
  });
});

describe("対象判定", () => {
  it("対象外イベントは skipped event_type, Queue 投入なし", async () => {
    const { deps, queue } = buildCtx({});
    const res = await handleWebhook(
      await makeRequest(
        { type: "page.deleted", entity: { type: "page", id: "p" } },
        { sign: true },
      ),
      deps,
    );
    expect(await res.json()).toEqual({ ok: true, skipped: "event_type" });
    expect(queue.sent).toHaveLength(0);
  });

  it("ページ以外は skipped non_page", async () => {
    const { deps } = buildCtx({});
    const res = await handleWebhook(
      await makeRequest(
        { type: "page.content_updated", entity: { type: "database", id: "d" } },
        { sign: true },
      ),
      deps,
    );
    expect(await res.json()).toEqual({ ok: true, skipped: "non_page" });
  });

  it("ページ取得失敗は skipped page_fetch_failed", async () => {
    const { deps } = buildCtx({}); // notionRoutes 未指定 = 500 を返す
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), deps);
    expect(await res.json()).toEqual({ ok: true, skipped: "page_fetch_failed" });
  });

  it("対象 DB 外は skipped other_database", async () => {
    const { deps, queue } = buildCtx({
      envOverrides: { NOTION_DATABASE_ID: "db-OTHER" },
      notionRoutes: [pageRoute(PAGE_BODY)],
    });
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), deps);
    expect(await res.json()).toEqual({ ok: true, skipped: "other_database" });
    expect(queue.sent).toHaveLength(0);
  });
});

describe("正常系", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = buildCtx({ notionRoutes: [pageRoute(PAGE_BODY)] });
  });

  it("D1 に page_state と job が保存され、Queue に delay 付きで投入される", async () => {
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), ctx.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const state = ctx.fake.pageStates.get("page-1");
    expect(state?.latest_last_edited_time).toBe("2026-06-06T09:59:00.000Z");
    expect(state?.status).toBe("pending");
    // debounce_until = now + 600s
    expect(state?.debounce_until).toBe("2026-06-06T10:10:05.000Z");

    expect(ctx.fake.jobs.get("job-fixed")?.status).toBe("queued");

    expect(ctx.queue.sent).toHaveLength(1);
    expect(ctx.queue.sent[0].options?.delaySeconds).toBe(600);
    expect(ctx.queue.sent[0].body).toMatchObject({
      job_id: "job-fixed",
      page_id: "page-1",
      event_type: "page.content_updated",
      last_edited_time: "2026-06-06T09:59:00.000Z",
    });
  });

  it("Queue 投入失敗は 500 queue_error", async () => {
    ctx.queue.failSend = true;
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), ctx.deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "queue_error" });
  });
});
