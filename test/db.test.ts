import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { FakeD1 } from "./helpers/fakeD1.js";

let fake: FakeD1;
let db: Db;

beforeEach(() => {
  fake = new FakeD1();
  db = new Db(fake.asD1());
});

describe("upsertPageState", () => {
  it("新規挿入と更新 (latest_last_edited_time / debounce_until / status=pending)", async () => {
    await db.upsertPageState({
      pageId: "p1",
      latestLastEditedTime: "2026-06-06T10:00:00.000Z",
      debounceUntil: "2026-06-06T10:10:00.000Z",
      now: "2026-06-06T10:00:05.000Z",
    });
    let row = await db.getPageState("p1");
    expect(row?.latest_last_edited_time).toBe("2026-06-06T10:00:00.000Z");
    expect(row?.status).toBe("pending");

    await db.upsertPageState({
      pageId: "p1",
      latestLastEditedTime: "2026-06-06T10:05:00.000Z",
      debounceUntil: "2026-06-06T10:15:00.000Z",
      now: "2026-06-06T10:05:05.000Z",
    });
    row = await db.getPageState("p1");
    expect(row?.latest_last_edited_time).toBe("2026-06-06T10:05:00.000Z");
    expect(row?.debounce_until).toBe("2026-06-06T10:15:00.000Z");
  });
});

describe("acquireLock", () => {
  beforeEach(async () => {
    await db.upsertPageState({
      pageId: "p1",
      latestLastEditedTime: "t",
      debounceUntil: "2026-06-06T10:10:00.000Z",
      now: "2026-06-06T10:00:00.000Z",
    });
  });

  it("空き lock は取得でき、二重取得は失敗する (同時実行排他)", async () => {
    const first = await db.acquireLock({
      pageId: "p1",
      now: "2026-06-06T10:11:00.000Z",
      lockUntil: "2026-06-06T10:13:00.000Z",
    });
    expect(first).toBe(true);

    const second = await db.acquireLock({
      pageId: "p1",
      now: "2026-06-06T10:11:30.000Z", // lock_until より前 = まだロック中
      lockUntil: "2026-06-06T10:13:30.000Z",
    });
    expect(second).toBe(false);
  });

  it("lock_until 失効後は再取得できる (デッドロック回避)", async () => {
    await db.acquireLock({
      pageId: "p1",
      now: "2026-06-06T10:11:00.000Z",
      lockUntil: "2026-06-06T10:13:00.000Z",
    });
    const retaken = await db.acquireLock({
      pageId: "p1",
      now: "2026-06-06T10:14:00.000Z", // lock_until を過ぎている
      lockUntil: "2026-06-06T10:16:00.000Z",
    });
    expect(retaken).toBe(true);
  });

  it("存在しないページの lock は取得失敗", async () => {
    const ok = await db.acquireLock({
      pageId: "nope",
      now: "2026-06-06T10:11:00.000Z",
      lockUntil: "2026-06-06T10:13:00.000Z",
    });
    expect(ok).toBe(false);
  });
});

describe("posted channels (冪等性)", () => {
  beforeEach(async () => {
    await db.upsertPageState({
      pageId: "p1",
      latestLastEditedTime: "t",
      debounceUntil: "d",
      now: "n",
    });
  });

  it("投稿済みチャンネルを追記・マージする", async () => {
    expect(await db.getPostedChannels("p1")).toEqual({});
    await db.addPostedChannels({ pageId: "p1", posted: { C1: "111.1" }, now: "n" });
    expect(await db.getPostedChannels("p1")).toEqual({ C1: "111.1" });
    await db.addPostedChannels({ pageId: "p1", posted: { C2: "222.2" }, now: "n" });
    expect(await db.getPostedChannels("p1")).toEqual({ C1: "111.1", C2: "222.2" });
  });
});

describe("summary_jobs", () => {
  it("insert と status 更新", async () => {
    await db.insertJob({
      id: "job1",
      pageId: "p1",
      eventType: "page.content_updated",
      payloadLastEditedTime: "2026-06-06T10:00:00.000Z",
      status: "queued",
      queuedAt: "2026-06-06T10:00:05.000Z",
      now: "2026-06-06T10:00:05.000Z",
    });
    let job = await db.getJob("job1");
    expect(job?.status).toBe("queued");

    await db.updateJobStatus({
      id: "job1",
      status: "skipped",
      skippedReason: "newer_edit",
      now: "2026-06-06T10:10:00.000Z",
    });
    job = await db.getJob("job1");
    expect(job?.status).toBe("skipped");
    expect(job?.skipped_reason).toBe("newer_edit");
  });
});

describe("markPageCompleted / markPageStatus", () => {
  beforeEach(async () => {
    await db.upsertPageState({
      pageId: "p1",
      latestLastEditedTime: "t",
      debounceUntil: "d",
      now: "n",
    });
  });

  it("completed は summary を保存し lock を解放する", async () => {
    await db.acquireLock({
      pageId: "p1",
      now: "2026-01-01T00:00:00.000Z",
      lockUntil: "2026-01-01T00:02:00.000Z",
    });
    await db.markPageCompleted({
      pageId: "p1",
      summary: "要約本文",
      now: "2026-01-01T00:01:00.000Z",
    });
    const row = await db.getPageState("p1");
    expect(row?.status).toBe("completed");
    expect(row?.last_summary).toBe("要約本文");
    expect(row?.lock_until).toBeNull();
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
