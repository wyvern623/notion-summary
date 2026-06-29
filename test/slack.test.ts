import { describe, expect, it } from "vitest";
import {
  SlackClient,
  buildSummaryMessage,
  markdownToMrkdwn,
  splitForSection,
} from "../src/services/slack.js";
import { createFetchMock } from "./helpers/fetchMock.js";

describe("markdownToMrkdwn", () => {
  it("見出しを太字に、箇条書きを • にする", () => {
    expect(markdownToMrkdwn("# 見出し\n- 項目1\n* 項目2")).toBe("*見出し*\n• 項目1\n• 項目2");
  });

  it("**bold** と __italic__ を Slack 形式へ", () => {
    expect(markdownToMrkdwn("**太字** と __斜体__")).toBe("*太字* と _斜体_");
  });

  it("code block の内側は変換しない", () => {
    const md = "- 項目\n```\n- これは変換されない\n# これも\n```";
    const out = markdownToMrkdwn(md);
    expect(out).toContain("• 項目"); // code block 外の箇条書きは変換される
    expect(out).toContain("- これは変換されない"); // code block 内は維持
    expect(out).toContain("# これも");
  });

  it("\\1 \\2 の番号プレースホルダを連番へ補正する", () => {
    expect(markdownToMrkdwn("\\1 最初\n\\2 次")).toBe("1 最初\n2 次");
  });
});

describe("splitForSection", () => {
  it("max 以下はそのまま1要素", () => {
    expect(splitForSection("short", 2800)).toEqual(["short"]);
  });

  it("長文を max 文字以内に分割する", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(2000)}`;
    const chunks = splitForSection(text, 2800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2800);
    }
  });
});

describe("buildSummaryMessage", () => {
  const input = {
    title: "テストページ",
    category: "研究ノート",
    updatedAt: "2026-06-06 19:00",
    summaryMarkdown: "- 要点1\n- 要点2",
    url: "https://notion.so/page",
  };

  it("header / fields / divider / section / context を含む", () => {
    const { blocks, text } = buildSummaryMessage(input);
    const types = (blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types[0]).toBe("header");
    expect(types).toContain("section");
    expect(types).toContain("divider");
    expect(types[types.length - 1]).toBe("context");
    expect(text).toContain("要約: テストページ");
  });

  it("header タイトルは最大140文字に切り詰める", () => {
    const { blocks } = buildSummaryMessage({ ...input, title: "あ".repeat(200) });
    const header = (blocks as Array<{ type: string; text?: { text: string } }>)[0];
    expect(header.text?.text.length).toBe(140);
  });

  it("長い要約は複数 section に分割される", () => {
    const { blocks } = buildSummaryMessage({ ...input, summaryMarkdown: "x".repeat(6000) });
    const sectionCount = (blocks as Array<{ type: string }>).filter(
      (b) => b.type === "section",
    ).length;
    // fields section 1 + summary sections 複数
    expect(sectionCount).toBeGreaterThan(2);
  });
});

describe("SlackClient.postToChannels", () => {
  const message = { text: "t", blocks: [] };

  it("全チャンネル成功で ts を返す", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("chat.postMessage"),
        responses: [{ body: { ok: true, ts: "111.1" } }, { body: { ok: true, ts: "222.2" } }],
      },
    ]);
    const client = new SlackClient("token", fetchImpl);
    const results = await client.postToChannels(["C1", "C2"], message);
    expect(results).toEqual([
      { channel: "C1", ok: true, ts: "111.1" },
      { channel: "C2", ok: true, ts: "222.2" },
    ]);
  });

  it("個別失敗でも他チャンネルへ継続する (エラーを握りつぶさない)", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("chat.postMessage"),
        responses: [
          { body: { ok: false, error: "channel_not_found" } },
          { body: { ok: true, ts: "222.2" } },
        ],
      },
    ]);
    const client = new SlackClient("token", fetchImpl);
    const results = await client.postToChannels(["C1", "C2"], message);
    expect(results[0]).toEqual({ channel: "C1", ok: false, error: "channel_not_found" });
    expect(results[1]).toEqual({ channel: "C2", ok: true, ts: "222.2" });
  });
});
