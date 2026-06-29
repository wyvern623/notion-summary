/**
 * Gemini API クライアント (spec §12)。
 *
 * - 指定モデルで要約を生成する。
 * - モデルが not found / deprecated / retired / unsupported なら既定モデルへフォールバックする。
 * - フォールバックも不可なら `要約生成エラー: ...` を要約本文として返す (spec §12)。
 * - 429 / 5xx などの一時障害は GeminiError(kind="transient") を throw し、Queue retry に委ねる。
 *
 * Queue Consumer からのみ呼ぶ。Webhook 受付時には呼ばない。
 */
import type { SummaryLength, SummaryStyle } from "../types.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
export const SUMMARY_ERROR_PREFIX = "要約生成エラー:";

type GeminiErrorKind = "transient" | "model_unavailable" | "permanent";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: GeminiErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
  defaultModel: string;
  length: SummaryLength;
  style: SummaryStyle;
  fetchImpl?: typeof fetch;
}

export interface SummarizeInput {
  title: string;
  markdown: string;
}

export class GeminiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * 要約を生成する。
   * - 成功: 要約本文。
   * - モデル不可で fallback も不可: `要約生成エラー: ...` 文字列 (呼び出し側は prefix で検知)。
   * - 一時障害: GeminiError(kind="transient") を throw (retry 対象)。
   */
  async summarize(input: SummarizeInput): Promise<string> {
    const prompt = buildPrompt(input, this.opts.length, this.opts.style);

    try {
      return await this.generate(this.opts.model, prompt);
    } catch (error) {
      const err = toGeminiError(error);
      if (err.kind === "transient") throw err;

      if (err.kind === "model_unavailable" && this.opts.model !== this.opts.defaultModel) {
        try {
          return await this.generate(this.opts.defaultModel, prompt);
        } catch (fallbackError) {
          const fbErr = toGeminiError(fallbackError);
          if (fbErr.kind === "transient") throw fbErr;
          return `${SUMMARY_ERROR_PREFIX} ${fbErr.message}`;
        }
      }
      return `${SUMMARY_ERROR_PREFIX} ${err.message}`;
    }
  }

  private async generate(model: string, prompt: string): Promise<string> {
    const url = `${GEMINI_API_BASE}/v1beta/models/${model}:generateContent?key=${this.opts.apiKey}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    if (!res.ok) {
      const message = await readErrorMessage(res);
      throw classifyHttpError(res.status, message);
    }

    const data = (await res.json()) as GeminiResponse;
    const text = extractText(data);
    if (text.length === 0) {
      throw new GeminiError("空の応答", "permanent", res.status);
    }
    return text;
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function extractText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    return body.error?.message ?? body.error?.status ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function classifyHttpError(status: number, message: string): GeminiError {
  if (status === 429 || status >= 500) {
    return new GeminiError(message, "transient", status);
  }
  if (status === 404 || isModelUnavailableMessage(message)) {
    return new GeminiError(message, "model_unavailable", status);
  }
  return new GeminiError(message, "permanent", status);
}

function isModelUnavailableMessage(message: string): boolean {
  return /not found|deprecated|retired|unsupported|not supported|unavailable/i.test(message);
}

function toGeminiError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  // ネットワーク例外などは一時障害として retry に回す。
  const message = error instanceof Error ? error.message : String(error);
  return new GeminiError(message, "transient");
}

const LENGTH_INSTRUCTION: Record<SummaryLength, string> = {
  short: "3〜5 文で簡潔にまとめる。",
  medium: "10 文程度で要点を押さえてまとめる。",
  long: "20 文以上で詳細にまとめる。",
};

const STYLE_INSTRUCTION: Record<SummaryStyle, string> = {
  bullet: "箇条書きで出力する。",
  paragraph: "段落形式で出力する。",
};

/**
 * 要約プロンプトを構築する (spec §12 のプロンプト方針)。
 * 読者は「研究室に配属された学部生」。プロンプトは本ファイルに集約する。
 */
export function buildPrompt(
  input: SummarizeInput,
  length: SummaryLength,
  style: SummaryStyle,
): string {
  return [
    "あなたは技術文書を要約する専門家です。",
    "読者は研究室に配属されたばかりの学部生です。",
    "",
    "次の方針で要約してください。",
    "- 技術的詳細を保持する。",
    "- 新規性・貢献・従来技術との差分を明示する。",
    "- 重要な略語は初出時に正式名称を併記する。",
    "- 結論・行動項目・今後の課題を抽出する。",
    "- 原文の論理構成に沿って整理する。",
    "- 冒頭の挨拶や導入文は出力しない。",
    `- ${LENGTH_INSTRUCTION[length]}`,
    `- ${STYLE_INSTRUCTION[style]}`,
    "",
    `タイトル: ${input.title}`,
    "",
    "本文 (Markdown):",
    input.markdown,
  ].join("\n");
}
