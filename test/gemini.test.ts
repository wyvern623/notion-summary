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
    const p = buildPrompt({ title: "T", markdown: "本文" }, "short", "paragraph");
    expect(p).toContain("学部生");
    expect(p).toContain("3〜5 文");
    expect(p).toContain("段落形式");
    expect(p).toContain("タイトル: T");
    expect(p).toContain("本文");
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
});
