import { describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig, parseCsv } from "../src/config.js";
import type { Env } from "../src/types.js";

/** D1 は config では使わないので最小スタブで足りる。 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ...overrides,
  } as Env;
}

describe("parseCsv", () => {
  it("空・undefined は空配列", () => {
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("  ,  ")).toEqual([]);
  });

  it("trim して非空要素のみ返す", () => {
    expect(parseCsv("a, b ,,c")).toEqual(["a", "b", "c"]);
  });
});

describe("loadConfig defaults", () => {
  it("var 未設定時は spec のデフォルトを適用する", () => {
    const c = loadConfig(makeEnv());
    expect(c.notionVersion).toBe(DEFAULTS.notionVersion);
    expect(c.summaryDelaySeconds).toBe(600);
    expect(c.summaryMinIntervalSeconds).toBe(1800);
    expect(c.geminiModel).toBe("gemini-2.5-flash-lite");
    expect(c.summaryLength).toBe("medium");
    expect(c.summaryStyle).toBe("bullet");
    expect(c.notionPageSize).toBe(100);
    expect(c.notionMaxBlockFetches).toBe(40);
    expect(c.notionMaxBlocks).toBe(800);
    expect(c.notionMaxMarkdownChars).toBe(30000);
    expect(c.logLevel).toBe("INFO");
    expect(c.debugVerbose).toBe(false);
    expect(c.summaryMaxRetries).toBe(3);
    expect(c.cronMaxPages).toBe(3);
    expect(c.notionEventTypes).toEqual(["page.content_updated", "page.created"]);
    expect(c.notionDatabaseId).toBeUndefined();
  });

  it("secrets 未設定なら undefined / 空配列のまま (例外を投げない)", () => {
    const c = loadConfig(makeEnv());
    expect(c.notionApiToken).toBeUndefined();
    expect(c.notionWebhookToken).toBeUndefined();
    expect(c.geminiApiKey).toBeUndefined();
    expect(c.slackBotToken).toBeUndefined();
    expect(c.slackChannelIds).toEqual([]);
  });
});

describe("loadConfig overrides & validation", () => {
  it("有効な値を反映する", () => {
    const c = loadConfig(
      makeEnv({
        NOTION_VERSION: "2025-09-03",
        SUMMARY_DELAY_SECONDS: "120",
        SUMMARY_LENGTH: "long",
        SUMMARY_STYLE: "paragraph",
        NOTION_DATABASE_ID: "db-123",
        SLACK_SUMMARY_CHANNEL_ID: "C1, C2",
        DEBUG_VERBOSE: "true",
        LOG_LEVEL: "DEBUG",
      }),
    );
    expect(c.notionVersion).toBe("2025-09-03");
    expect(c.summaryDelaySeconds).toBe(120);
    expect(c.summaryLength).toBe("long");
    expect(c.summaryStyle).toBe("paragraph");
    expect(c.notionDatabaseId).toBe("db-123");
    expect(c.slackChannelIds).toEqual(["C1", "C2"]);
    expect(c.debugVerbose).toBe(true);
    expect(c.logLevel).toBe("DEBUG");
  });

  it("不正な enum 値はデフォルトに落とす", () => {
    const c = loadConfig(
      makeEnv({ SUMMARY_LENGTH: "xxl", SUMMARY_STYLE: "table", LOG_LEVEL: "TRACE" }),
    );
    expect(c.summaryLength).toBe("medium");
    expect(c.summaryStyle).toBe("bullet");
    expect(c.logLevel).toBe("INFO");
  });

  it("不正な数値 var はデフォルトに落とす", () => {
    const c = loadConfig(
      makeEnv({ SUMMARY_DELAY_SECONDS: "abc", NOTION_PAGE_SIZE: "0", NOTION_MAX_BLOCKS: "-5" }),
    );
    expect(c.summaryDelaySeconds).toBe(600);
    expect(c.notionPageSize).toBe(100);
    expect(c.notionMaxBlocks).toBe(800);
  });
});
