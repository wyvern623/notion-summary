import { describe, expect, it } from "vitest";
import { type NotionBlock, blocksToMarkdown } from "../src/markdown.js";

/** rich_text を1要素持つブロックを作る簡易ヘルパー。 */
function block(type: string, text: string, extra: Record<string, unknown> = {}): NotionBlock {
  return {
    type,
    [type]: { rich_text: [{ plain_text: text }], ...extra },
  };
}

describe("blocksToMarkdown 見出し・本文・箇条書き", () => {
  it("見出しレベルを変換する", () => {
    const md = blocksToMarkdown([
      block("heading_1", "H1"),
      block("heading_2", "H2"),
      block("heading_3", "H3"),
      block("paragraph", "本文"),
    ]);
    expect(md).toBe("# H1\n## H2\n### H3\n本文");
  });

  it("箇条書きと番号付きリスト (連続採番)", () => {
    const md = blocksToMarkdown([
      block("bulleted_list_item", "A"),
      block("numbered_list_item", "一"),
      block("numbered_list_item", "二"),
      block("numbered_list_item", "三"),
    ]);
    expect(md).toBe("- A\n1. 一\n2. 二\n3. 三");
  });

  it("番号付きリストは非リストで中断すると採番がリセットされる", () => {
    const md = blocksToMarkdown([
      block("numbered_list_item", "一"),
      block("paragraph", "区切り"),
      block("numbered_list_item", "再"),
    ]);
    expect(md).toBe("1. 一\n区切り\n1. 再");
  });
});

describe("blocksToMarkdown その他ブロック", () => {
  it("to_do のチェック状態", () => {
    const md = blocksToMarkdown([
      block("to_do", "done", { checked: true }),
      block("to_do", "todo", { checked: false }),
    ]);
    expect(md).toBe("- [x] done\n- [ ] todo");
  });

  it("quote / callout / toggle / divider", () => {
    const md = blocksToMarkdown([
      block("quote", "引用"),
      block("callout", "注意"),
      block("toggle", "トグル"),
      { type: "divider", divider: {} },
    ]);
    expect(md).toBe("> 引用\n> 注意\n- トグル\n---");
  });

  it("code は fenced code block (言語付き) を維持する", () => {
    const md = blocksToMarkdown([block("code", "console.log(1)", { language: "javascript" })]);
    expect(md).toBe("```javascript\nconsole.log(1)\n```");
  });

  it("child_page / child_database はラベル付きで子を辿らない", () => {
    const md = blocksToMarkdown([
      {
        type: "child_page",
        child_page: { title: "サブページ" },
        children: [block("paragraph", "辿られないはず")],
      },
      { type: "child_database", child_database: { title: "サブDB" } },
    ]);
    expect(md).toBe("- [ページ] サブページ\n- [データベース] サブDB");
  });

  it("メディアは caption ありなしで表現を変える", () => {
    const md = blocksToMarkdown([
      { type: "image", image: { caption: [{ plain_text: "図1" }] } },
      { type: "file", file: { caption: [] } },
    ]);
    expect(md).toBe("[image: 図1]\n[file]");
  });
});

describe("blocksToMarkdown ネスト", () => {
  it("子ブロックは深さに応じて2スペースずつインデントする", () => {
    const md = blocksToMarkdown([
      {
        ...block("bulleted_list_item", "親"),
        children: [
          {
            ...block("bulleted_list_item", "子"),
            children: [block("bulleted_list_item", "孫")],
          },
        ],
      },
    ]);
    expect(md).toBe("- 親\n  - 子\n    - 孫");
  });
});
