import { describe, expect, it } from "vitest";
import {
  GeminiClient,
  GeminiError,
  SUMMARY_ERROR_PREFIX,
  buildPrompt,
} from "../src/services/gemini.js";
import { createFetchMock } from "./helpers/fetchMock.js";

const BASE_OPTS = {
  apiKey: "key",
  model: "gemini-2.5-flash-lite",
  defaultModel: "gemini-2.5-flash-lite",
  length: "medium" as const,
  style: "bullet" as const,
};

function okResponse(text: string) {
  return { body: { candidates: [{ content: { parts: [{ text }] } }] } };
}

describe("buildPrompt", () => {
  it("読者・方針・長さ/形式・本文を含める", () => {
    const p = buildPrompt({ title: "T", markdown: "本文テキスト" }, "short", "paragraph");
    expect(p).toContain("学部生");
    expect(p).toContain("3〜5 文");
    expect(p).toContain("段落形式");
    expect(p).toContain("タイトル: T");
    expect(p).toContain("本文テキスト");
  });

  it("忠実性ルールと区切りを含む (ハルシネーション/インジェクション対策)", () => {
    const p = buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet");
    expect(p).toContain("創作したりしない");
    expect(p).toContain("要約できる本文がありません。");
    expect(p).toContain("-----"); // 入力文書の区切り
  });

  it("重要度を出すための構成ルール (要点/太字/重複排除) を含む", () => {
    const p = buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet");
    expect(p).toContain("要点"); // 先頭に要点ブロック
    expect(p).toContain("**太字**"); // 重要語句の強調
    expect(p).toContain("重複を避ける"); // 冗長・重複の排除
  });

  it("medium は重複を避けた短めの指示になっている", () => {
    const p = buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet");
    expect(p).toContain("6〜8 項目");
  });

  it("category は指定値を、未指定なら『なし』を入れる", () => {
    expect(
      buildPrompt({ title: "T", category: "論文DB", markdown: "M" }, "medium", "bullet"),
    ).toContain("カテゴリ: 論文DB");
    expect(buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet")).toContain(
      "カテゴリ: なし",
    );
  });
});

describe("summarize 成功", () => {
  it("要約本文を返す", async () => {
    const fetchImpl = createFetchMock([
      { match: (u) => u.includes(":generateContent"), responses: [okResponse("これは要約です")] },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out).toBe("これは要約です");
  });
});

describe("summarize モデル fallback", () => {
  it("指定モデル 404 → 既定モデルで成功する", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/models/custom-model:"),
        responses: [{ status: 404, body: { error: { message: "model not found" } } }],
      },
      {
        match: (u) => u.includes("/models/gemini-2.5-flash-lite:"),
        responses: [okResponse("fallback 要約")],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, model: "custom-model", fetchImpl });
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out).toBe("fallback 要約");
  });

  it("既定モデルも不可なら『要約生成エラー:』文字列を返す", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/models/custom-model:"),
        responses: [{ status: 404, body: { error: { message: "model not found" } } }],
      },
      {
        match: (u) => u.includes("/models/gemini-2.5-flash-lite:"),
        responses: [{ status: 404, body: { error: { message: "also gone" } } }],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, model: "custom-model", fetchImpl });
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out.startsWith(SUMMARY_ERROR_PREFIX)).toBe(true);
  });
});

describe("summarize 一時障害は throw (retry 対象)", () => {
  it("429 は GeminiError(transient) を throw する", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes(":generateContent"),
        responses: [{ status: 429, body: { error: { message: "rate limited" } } }],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.summarize({ title: "T", markdown: "M" })).rejects.toMatchObject({
      name: "GeminiError",
      kind: "transient",
    });
  });

  it("5xx も throw する", async () => {
    const fetchImpl = createFetchMock([
      { match: (u) => u.includes(":generateContent"), responses: [{ status: 503, body: {} }] },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.summarize({ title: "T", markdown: "M" })).rejects.toBeInstanceOf(
      GeminiError,
    );
  });

  it("混雑エラー (high demand) は transient で throw → retry 対象", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes(":generateContent"),
        responses: [
          { status: 503, body: { error: { message: "currently experiencing high demand" } } },
        ],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.summarize({ title: "T", markdown: "M" })).rejects.toMatchObject({
      kind: "transient",
    });
  });
});

describe("課金切れは即 failed (リトライしない)", () => {
  it("クレジット切れ (429+billing文言) は throw せず『要約生成エラー:』を返す", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes(":generateContent"),
        responses: [
          { status: 429, body: { error: { message: "Your prepayment credits are depleted." } } },
        ],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    // permanent 扱い → throw されず error 文字列を返す → consumer は retry せず failed にする
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out.startsWith(SUMMARY_ERROR_PREFIX)).toBe(true);
  });
});
