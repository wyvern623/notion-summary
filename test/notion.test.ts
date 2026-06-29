import { describe, expect, it } from "vitest";
import { NotionApiError, NotionClient, extractPageId } from "../src/services/notion.js";
import { createFetchMock } from "./helpers/fetchMock.js";

const BASE_OPTS = {
  token: "tok",
  notionVersion: "2022-06-28",
  pageSize: 100,
  maxBlockFetches: 40,
  maxBlocks: 800,
  maxMarkdownChars: 30000,
};

describe("extractPageId", () => {
  it("ダッシュ無し32桁を整形する", () => {
    expect(extractPageId("11112222333344445555666677778888")).toBe(
      "11112222-3333-4444-5555-666677778888",
    );
  });

  it("Notion URL の末尾IDを抽出する (タイトル末尾が hex でも誤らない)", () => {
    expect(extractPageId("https://www.notion.so/My-Page-aaaabbbbccccddddeeeeffff00001111")).toBe(
      "aaaabbbb-cccc-dddd-eeee-ffff00001111",
    );
  });

  it("クエリ/ハッシュ付きでも抽出する", () => {
    expect(extractPageId("https://notion.so/aaaabbbbccccddddeeeeffff00001111?v=x#h")).toBe(
      "aaaabbbb-cccc-dddd-eeee-ffff00001111",
    );
  });

  it("16進にならない入力は null", () => {
    expect(extractPageId("not-a-valid-id")).toBeNull();
  });
});

describe("getPageInfo", () => {
  it("title プロパティ・URL・親DBを抽出する", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/v1/pages/"),
        responses: [
          {
            body: {
              id: "page-1",
              url: "https://notion.so/page-1",
              last_edited_time: "2026-06-06T10:00:00.000Z",
              parent: { type: "database_id", database_id: "db-9" },
              properties: {
                Name: { type: "title", title: [{ plain_text: "研究ノート" }] },
              },
            },
          },
        ],
      },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, fetchImpl });
    const info = await client.getPageInfo("page-1");
    expect(info.title).toBe("研究ノート");
    expect(info.url).toBe("https://notion.so/page-1");
    expect(info.lastEditedTime).toBe("2026-06-06T10:00:00.000Z");
    expect(info.parentDatabaseId).toBe("db-9");
  });

  it("title が取れなければ『タイトルなし』", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/v1/pages/"),
        responses: [{ body: { id: "p", url: "", last_edited_time: "", properties: {} } }],
      },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, fetchImpl });
    const info = await client.getPageInfo("p");
    expect(info.title).toBe("タイトルなし");
    expect(info.parentDatabaseId).toBeUndefined();
  });
});

describe("getPageContent ページネーション", () => {
  it("has_more を辿って全ブロックを連結する", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/children"),
        responses: [
          {
            body: {
              results: [
                { type: "paragraph", paragraph: { rich_text: [{ plain_text: "1ページ目" }] } },
              ],
              has_more: true,
              next_cursor: "cur1",
            },
          },
          {
            body: {
              results: [
                { type: "paragraph", paragraph: { rich_text: [{ plain_text: "2ページ目" }] } },
              ],
              has_more: false,
              next_cursor: null,
            },
          },
        ],
      },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, fetchImpl });
    const content = await client.getPageContent("p");
    expect(content.markdown).toBe("1ページ目\n2ページ目");
    expect(content.blockCount).toBe(2);
    expect(content.truncated).toBe(false);
  });

  it("maxBlocks 到達で打ち切り、省略注記を付ける (300ブロック相当)", async () => {
    const results = Array.from({ length: 300 }, (_, i) => ({
      type: "paragraph",
      paragraph: { rich_text: [{ plain_text: `行${i}` }] },
    }));
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/children"),
        responses: [{ body: { results, has_more: false, next_cursor: null } }],
      },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, maxBlocks: 50, fetchImpl });
    const content = await client.getPageContent("p");
    expect(content.blockCount).toBe(50);
    expect(content.truncated).toBe(true);
    expect(content.markdown).toContain("[本文が長いため、一部のブロックは省略されています]");
  });

  it("子ブロックを再帰取得する", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/blocks/parent/children"),
        responses: [
          {
            body: {
              results: [
                {
                  id: "child-1",
                  type: "bulleted_list_item",
                  has_children: true,
                  bulleted_list_item: { rich_text: [{ plain_text: "親" }] },
                },
              ],
              has_more: false,
              next_cursor: null,
            },
          },
        ],
      },
      {
        match: (u) => u.includes("/blocks/child-1/children"),
        responses: [
          {
            body: {
              results: [
                {
                  id: "g",
                  type: "bulleted_list_item",
                  bulleted_list_item: { rich_text: [{ plain_text: "子" }] },
                },
              ],
              has_more: false,
              next_cursor: null,
            },
          },
        ],
      },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, fetchImpl });
    const content = await client.getPageContent("parent");
    expect(content.markdown).toBe("- 親\n  - 子");
  });
});

describe("エラー分類", () => {
  it("429 は retryable=true", async () => {
    const fetchImpl = createFetchMock([
      { match: () => true, responses: [{ status: 429, body: { message: "rate limited" } }] },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.getPageInfo("p")).rejects.toMatchObject({
      name: "NotionApiError",
      retryable: true,
    });
  });

  it("404 は retryable=false", async () => {
    const fetchImpl = createFetchMock([
      { match: () => true, responses: [{ status: 404, body: { message: "not found" } }] },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.getPageInfo("p")).rejects.toMatchObject({
      name: "NotionApiError",
      retryable: false,
    });
  });

  it("NotionApiError は status を保持する", async () => {
    const fetchImpl = createFetchMock([
      { match: () => true, responses: [{ status: 503, body: {} }] },
    ]);
    const client = new NotionClient({ ...BASE_OPTS, fetchImpl });
    try {
      await client.getPageContent("p");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NotionApiError);
      expect((e as NotionApiError).status).toBe(503);
    }
  });
});
