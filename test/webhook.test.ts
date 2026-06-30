import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { type WebhookDeps, handleWebhook } from "../src/handlers/webhook.js";
import type { Env } from "../src/types.js";
import { computeHmacSha256Hex } from "../src/utils/crypto.js";
import { createLogger } from "../src/utils/logger.js";
import { FakeD1 } from "./helpers/fakeD1.js";

const TOKEN = "whsec";
const NOW = new Date("2026-06-06T10:00:05.000Z");

interface Ctx {
  fake: FakeD1;
  deps: WebhookDeps;
}

/** 軽量 Webhook は Notion を叩かないので D1 だけで完結する。 */
function buildCtx(envOverrides: Partial<Env> = {}): Ctx {
  const env = {
    DB: {} as Env["DB"],
    NOTION_WEBHOOK_TOKEN: TOKEN,
    SUMMARY_DELAY_SECONDS: "600",
    ...envOverrides,
  } as Env;
  const config = loadConfig(env);
  const fake = new FakeD1();
  const deps: WebhookDeps = {
    config,
    db: new Db(fake.asD1()),
    now: () => NOW,
    uuid: () => "job-fixed",
    logger: createLogger("ERROR"),
  };
  return { fake, deps };
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

describe("入力検証", () => {
  it("JSON 不正は 400", async () => {
    const { deps } = buildCtx();
    const req = new Request("https://worker/notion/webhook", { method: "POST", body: "{not json" });
    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid json" });
  });

  it("verification_token は 200 {ok:true} (署名不要)", async () => {
    const { deps } = buildCtx();
    const res = await handleWebhook(await makeRequest({ verification_token: "tok" }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("署名検証 (fail-closed)", () => {
  it("NOTION_WEBHOOK_TOKEN 未設定の通常イベントは 500 (fail-closed)", async () => {
    const { deps } = buildCtx({ NOTION_WEBHOOK_TOKEN: undefined });
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: false }), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "webhook_not_configured" });
  });

  it("署名不一致は 401", async () => {
    const { deps } = buildCtx();
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

describe("対象判定 (Notion は叩かない)", () => {
  it("対象外イベントは skipped event_type, D1 更新なし", async () => {
    const { deps, fake } = buildCtx();
    const res = await handleWebhook(
      await makeRequest(
        { type: "page.deleted", entity: { type: "page", id: "p" } },
        { sign: true },
      ),
      deps,
    );
    expect(await res.json()).toEqual({ ok: true, skipped: "event_type" });
    expect(fake.pageStates.size).toBe(0);
  });

  it("ページ以外は skipped non_page", async () => {
    const { deps } = buildCtx();
    const res = await handleWebhook(
      await makeRequest(
        { type: "page.content_updated", entity: { type: "database", id: "d" } },
        { sign: true },
      ),
      deps,
    );
    expect(await res.json()).toEqual({ ok: true, skipped: "non_page" });
  });

  it("page ID なしは skipped no_page_id", async () => {
    const { deps } = buildCtx();
    const res = await handleWebhook(
      await makeRequest({ type: "page.content_updated", entity: { type: "page" } }, { sign: true }),
      deps,
    );
    expect(await res.json()).toEqual({ ok: true, skipped: "no_page_id" });
  });
});

describe("正常系", () => {
  it("D1 に page_state(pending, debounce_until) と job が記録される (Notion 非依存)", async () => {
    const { deps, fake } = buildCtx();
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const state = fake.pageStates.get("page-1");
    expect(state?.status).toBe("pending");
    // debounce_until = now + 600s。Cron がこの時刻を過ぎたら処理する。
    expect(state?.debounce_until).toBe("2026-06-06T10:10:05.000Z");
    expect(state?.latest_last_edited_time).toBe(""); // 版は Cron 要約時に記録
    expect(fake.jobs.get("job-fixed")?.status).toBe("queued");
  });

  it("D1 更新失敗は 500 db_error", async () => {
    const { deps } = buildCtx();
    deps.db.upsertPageState = async () => {
      throw new Error("d1 down");
    };
    const res = await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db_error" });
  });
});

describe("クールダウン (再要約間隔)", () => {
  // NOW = 2026-06-06T10:00:05Z, delay=600s → 通常 debounce = 10:10:05
  function seedSummarized(ctx: Ctx, lastSummarizedAt: string) {
    ctx.fake.pageStates.set("page-1", {
      page_id: "page-1",
      latest_last_edited_time: "2026-06-06T08:00:00.000Z",
      debounce_until: "2026-06-06T09:00:00.000Z",
      status: "completed",
      lock_until: null,
      last_summarized_at: lastSummarizedAt,
      last_summary: "前回の要約",
      slack_ts: null,
      retry_count: 0,
      error_message: null,
      created_at: "x",
      updated_at: "x",
    });
  }

  it("前回要約が最近なら debounce_until = 前回要約 + 30分 (クールダウン優先)", async () => {
    const ctx = buildCtx();
    seedSummarized(ctx, "2026-06-06T09:50:00.000Z"); // +30分 = 10:20:00 > 10:10:05
    await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), ctx.deps);
    expect(ctx.fake.pageStates.get("page-1")?.debounce_until).toBe("2026-06-06T10:20:00.000Z");
  });

  it("前回要約が十分前なら通常デバウンス (now + 10分)", async () => {
    const ctx = buildCtx();
    seedSummarized(ctx, "2026-06-06T09:00:00.000Z"); // +30分 = 09:30:00 < 10:10:05
    await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), ctx.deps);
    expect(ctx.fake.pageStates.get("page-1")?.debounce_until).toBe("2026-06-06T10:10:05.000Z");
  });

  it("初回 (要約履歴なし) は通常デバウンス", async () => {
    const ctx = buildCtx();
    await handleWebhook(await makeRequest(VALID_EVENT, { sign: true }), ctx.deps);
    expect(ctx.fake.pageStates.get("page-1")?.debounce_until).toBe("2026-06-06T10:10:05.000Z");
  });
});
