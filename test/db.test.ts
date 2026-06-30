import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { FakeD1 } from "./helpers/fakeD1.js";

let fake: FakeD1;
let db: Db;

beforeEach(() => {
  fake = new FakeD1();
  db = new Db(fake.asD1());
});

describe("upsertPageState (軽量)", () => {
  it("新規は status=pending / latest は空 / debounce を記録", async () => {
    await db.upsertPageState({
      pageId: "p1",
      debounceUntil: "2026-06-06T10:10:00.000Z",
      now: "2026-06-06T10:00:05.000Z",
    });
    const row = await db.getPageState("p1");
    expect(row?.status).toBe("pending");
    expect(row?.debounce_until).toBe("2026-06-06T10:10:00.000Z");
    expect(row?.latest_last_edited_time).toBe(""); // 新規は空
  });

  it("既存行は debounce/status のみ更新し latest_last_edited_time は保持する", async () => {
    await db.upsertPageState({ pageId: "p1", debounceUntil: "d1", now: "n1" });
    // 要約完了で latest を記録した状態を作る
    await db.markPageCompleted({
      pageId: "p1",
      lastEditedTime: "2026-06-06T09:00:00.000Z",
      summary: "s",
      expectedDebounceUntil: "d1",
      now: "n1",
    });
    // 次の Webhook (upsert) で latest は上書きされない
    await db.upsertPageState({ pageId: "p1", debounceUntil: "d2", now: "n2" });
    const row = await db.getPageState("p1");
    expect(row?.status).toBe("pending");
    expect(row?.debounce_until).toBe("d2");
    expect(row?.latest_last_edited_time).toBe("2026-06-06T09:00:00.000Z"); // 保持
  });
});

describe("acquireLock", () => {
  beforeEach(async () => {
    await db.upsertPageState({ pageId: "p1", debounceUntil: "2026-06-06T10:10:00.000Z", now: "n" });
  });

  it("空き lock は取得でき、二重取得は失敗する (同時実行排他)", async () => {
    expect(
      await db.acquireLock({
        pageId: "p1",
        now: "2026-06-06T10:11:00.000Z",
        lockUntil: "2026-06-06T10:13:00.000Z",
      }),
    ).toBe(true);
    expect(
      await db.acquireLock({
        pageId: "p1",
        now: "2026-06-06T10:11:30.000Z",
        lockUntil: "2026-06-06T10:13:30.000Z",
      }),
    ).toBe(false);
  });

  it("lock_until 失効後は再取得できる (デッドロック回避)", async () => {
    await db.acquireLock({
      pageId: "p1",
      now: "2026-06-06T10:11:00.000Z",
      lockUntil: "2026-06-06T10:13:00.000Z",
    });
    expect(
      await db.acquireLock({
        pageId: "p1",
        now: "2026-06-06T10:14:00.000Z",
        lockUntil: "2026-06-06T10:16:00.000Z",
      }),
    ).toBe(true);
  });

  it("存在しないページの lock は取得失敗", async () => {
    expect(await db.acquireLock({ pageId: "nope", now: "x", lockUntil: "y" })).toBe(false);
  });
});

describe("posted channels (冪等性)", () => {
  beforeEach(async () => {
    await db.upsertPageState({ pageId: "p1", debounceUntil: "d", now: "n" });
  });

  it("投稿済みチャンネルを追記・マージする", async () => {
    expect(await db.getPostedChannels("p1")).toEqual({});
    await db.addPostedChannels({ pageId: "p1", posted: { C1: "111.1" }, now: "n" });
    expect(await db.getPostedChannels("p1")).toEqual({ C1: "111.1" });
    await db.addPostedChannels({ pageId: "p1", posted: { C2: "222.2" }, now: "n" });
    expect(await db.getPostedChannels("p1")).toEqual({ C1: "111.1", C2: "222.2" });
  });
});

describe("getDuePages (Cron ポーリング)", () => {
  it("pending かつ debounce_until <= now かつ未ロックのみ古い順に返す", async () => {
    await db.upsertPageState({
      pageId: "due1",
      debounceUntil: "2026-06-06T10:05:00.000Z",
      now: "n",
    });
    await db.upsertPageState({
      pageId: "due2",
      debounceUntil: "2026-06-06T10:00:00.000Z",
      now: "n",
    });
    await db.upsertPageState({
      pageId: "future",
      debounceUntil: "2026-06-06T23:00:00.000Z",
      now: "n",
    });

    const due = await db.getDuePages("2026-06-06T10:10:00.000Z", 10);
    expect(due.map((p) => p.page_id)).toEqual(["due2", "due1"]); // debounce 昇順
  });

  it("ロック中のページは除外する", async () => {
    await db.upsertPageState({
      pageId: "locked",
      debounceUntil: "2026-06-06T10:00:00.000Z",
      now: "n",
    });
    await db.acquireLock({
      pageId: "locked",
      now: "2026-06-06T10:09:00.000Z",
      lockUntil: "2026-06-06T10:11:00.000Z",
    });
    const due = await db.getDuePages("2026-06-06T10:10:00.000Z", 10);
    expect(due.find((p) => p.page_id === "locked")).toBeUndefined();
  });

  it("limit で件数を絞る", async () => {
    for (let i = 0; i < 5; i++) {
      await db.upsertPageState({
        pageId: `p${i}`,
        debounceUntil: "2026-06-06T10:00:00.000Z",
        now: "n",
      });
    }
    expect(await db.getDuePages("2026-06-06T10:10:00.000Z", 2)).toHaveLength(2);
  });
});

describe("bumpRetry", () => {
  it("retry_count を +1 し pending に戻して lock を解放する", async () => {
    await db.upsertPageState({ pageId: "p1", debounceUntil: "d", now: "n" });
    await db.acquireLock({
      pageId: "p1",
      now: "2026-01-01T00:00:00.000Z",
      lockUntil: "2026-01-01T00:02:00.000Z",
    });
    await db.bumpRetry("p1", "2026-01-01T00:01:00.000Z", "gemini transient");
    const row = await db.getPageState("p1");
    expect(row?.status).toBe("pending");
    expect(row?.retry_count).toBe(1);
    expect(row?.lock_until).toBeNull();
    expect(row?.error_message).toBe("gemini transient");
  });
});

describe("summary_jobs", () => {
  it("insert と status 更新", async () => {
    await db.insertJob({
      id: "job1",
      pageId: "p1",
      eventType: "page.content_updated",
      payloadLastEditedTime: null,
      status: "queued",
      queuedAt: "2026-06-06T10:00:05.000Z",
      now: "2026-06-06T10:00:05.000Z",
    });
    expect((await db.getJob("job1"))?.status).toBe("queued");

    await db.updateJobStatus({
      id: "job1",
      status: "skipped",
      skippedReason: "no_change",
      now: "2026-06-06T10:10:00.000Z",
    });
    const job = await db.getJob("job1");
    expect(job?.status).toBe("skipped");
    expect(job?.skipped_reason).toBe("no_change");
  });
});

describe("markPageCompleted", () => {
  beforeEach(async () => {
    await db.upsertPageState({ pageId: "p1", debounceUntil: "DEB1", now: "n" });
  });

  it("debounce_until が想定どおりなら completed にし、版と要約を記録する", async () => {
    await db.markPageCompleted({
      pageId: "p1",
      lastEditedTime: "2026-06-06T10:00:00.000Z",
      summary: "要約本文",
      expectedDebounceUntil: "DEB1",
      now: "2026-06-06T10:01:00.000Z",
    });
    const row = await db.getPageState("p1");
    expect(row?.status).toBe("completed");
    expect(row?.last_summary).toBe("要約本文");
    expect(row?.latest_last_edited_time).toBe("2026-06-06T10:00:00.000Z");
    expect(row?.lock_until).toBeNull();
  });

  it("処理中に debounce_until が変わっていたら pending のまま残す (取りこぼし防止)", async () => {
    // 新しい Webhook が来て debounce_until が変わった状況
    await db.upsertPageState({ pageId: "p1", debounceUntil: "DEB2", now: "n2" });
    await db.markPageCompleted({
      pageId: "p1",
      lastEditedTime: "2026-06-06T10:00:00.000Z",
      summary: "要約本文",
      expectedDebounceUntil: "DEB1", // 拾った時点の値 (今は DEB2)
      now: "n3",
    });
    const row = await db.getPageState("p1");
    expect(row?.status).toBe("pending"); // completed にしない
    expect(row?.latest_last_edited_time).toBe("2026-06-06T10:00:00.000Z"); // 版は記録
  });
});

describe("markPageStatus", () => {
  beforeEach(async () => {
    await db.upsertPageState({ pageId: "p1", debounceUntil: "d", now: "n" });
  });

  it("failed は error_message を保存し lock を解放する", async () => {
    await db.markPageStatus({
      pageId: "p1",
      status: "failed",
      errorMessage: "gemini error",
      now: "n2",
    });
    const row = await db.getPageState("p1");
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toBe("gemini error");
    expect(row?.lock_until).toBeNull();
  });
});
