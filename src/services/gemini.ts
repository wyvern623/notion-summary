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
  /** 親 DB タイトルなどの分類情報。未指定なら「なし」として扱う。 */
  category?: string;
  markdown: string;
}

export class GeminiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiClientOptions) {
    // Workers ではグローバル fetch をメソッド呼び出しすると this がずれて
    // "Illegal invocation" になるため globalThis に束縛する。
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
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
  // 課金・クレジット切れはリトライしても直らないので即 permanent (無駄な再試行を防ぐ)。
  // status が 429 でもこちらを優先する。
  if (isBillingError(message)) {
    return new GeminiError(message, "permanent", status);
  }
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

/** 課金・残高不足系のエラー (リトライ不可)。混雑 ("high demand") はここに含めない。 */
function isBillingError(message: string): boolean {
  return /credit|billing|prepay|depleted|insufficient|payment|exceeded your current quota|quota.*exceeded/i.test(
    message,
  );
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

/** 入力文書を指示と分離するための区切り (プロンプトインジェクション対策)。 */
const DOC_DELIMITER = "-----";

/**
 * 要約プロンプトを構築する (spec §12 のプロンプト方針 + 忠実性/区切り/エッジ処理を強化)。
 * 読者は「研究室に配属された学部生」。プロンプトは本ファイルに集約する。
 */
export function buildPrompt(
  input: SummarizeInput,
  length: SummaryLength,
  style: SummaryStyle,
): string {
  const category = input.category?.trim() ? input.category.trim() : "なし";
  return [
    "# 役割",
    "あなたはAI分野の研究室に所属する優秀なリサーチアシスタントです。",
    "教授が作成した技術文書・研究資料を、指定された読者向けに正確かつ簡潔に要約します。",
    "",
    "# 対象読者",
    "研究室に配属されたばかりの学部生（その分野の前提知識は浅い）。",
    "",
    "# 目的",
    "長い文書の要点を短時間で把握できるようにする。",
    "",
    "# 出力ルール（厳守）",
    "- 日本語で出力する。",
    "- 冒頭の挨拶・前置き・「〜をまとめます」等の導入文は書かない。最初の行から要約本文を始める。",
    "- 【本文】に書かれている情報だけを使う。推測で補ったり、書かれていない事実を創作したりしない。判断できない点は無理に書かない。",
    "- タイトル・カテゴリは文脈情報として渡すだけ。要約本文の中で繰り返さない。",
    "- 本文末尾に「[本文が長いため、一部のブロックは省略されています]」がある場合は、取得できた範囲だけで要約する（省略への言及は不要）。",
    "- 要約できる本文が無い／極端に短い場合は、「要約できる本文がありません。」とだけ出力する。",
    "",
    "# 要約の方針",
    "1. 技術的詳細の保持: 提案手法の核心、実験設定、主要な結果（重要な数値・傾向）など、理解に不可欠な詳細は省略しない。",
    "2. 新規性・貢献の明示: 「最も重要な貢献(Contribution)」と「従来手法との違い」が一読で分かるようにする。",
    "3. 専門用語・略語: 専門用語はそのまま使う。重要な略語(Acronym)の初出時のみ正式名称を（）で併記する。",
    "4. 結論と次の一手: 文書の結論、今後の課題、（あれば）次に取るべき行動を明確に抽出する。",
    "5. 論理構成の踏襲: 可能な限り原文の構成（背景・目的 → 手法 → 結果 → 考察 等）に沿って整理する。",
    "6. 密度: 冗長な言い換えや一般論は避け、情報量の多い文にする。",
    "",
    "# 出力形式",
    `- 長さ: ${LENGTH_INSTRUCTION[length]}`,
    `- 形式: ${STYLE_INSTRUCTION[style]}`,
    "",
    "# 入力文書",
    `タイトル: ${input.title}`,
    `カテゴリ: ${category}`,
    DOC_DELIMITER,
    input.markdown,
    DOC_DELIMITER,
    "",
    `上記の入力文書を、方針と出力形式に従って${STYLE_INSTRUCTION[style]}`,
  ].join("\n");
}
