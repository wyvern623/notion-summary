/**
 * Slack 投稿クライアント (spec §13)。
 *
 * - Gemini の Markdown 要約を Slack mrkdwn へ変換する。
 * - Block Kit payload (header / fields / divider / summary sections / context) を構築する。
 * - 複数チャンネルへ投稿し、チャンネルごとの成否を返す (個別失敗は他チャンネルを止めない)。
 *
 * 投稿の冪等性 (投稿済みチャンネルの除外) は呼び出し側 (consumer) が担う。
 * 本クライアントは「与えられたチャンネルへ投稿し、結果を返す」ことに徹する。
 */
import type { SlackPostResult } from "../types.js";

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const HEADER_TITLE_MAX = 140;
const SECTION_TEXT_MAX = 2800;
const FALLBACK_TEXT_MAX = 3000;

export interface SummaryMessageInput {
  title: string;
  category: string;
  updatedAt: string;
  /** Gemini が生成した Markdown 要約本文。 */
  summaryMarkdown: string;
  url: string;
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

export class SlackClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    // Workers ではグローバル fetch をメソッド呼び出しすると this がずれて
    // "Illegal invocation" になるため globalThis に束縛する。
    this.fetchImpl = fetchImpl ?? fetch.bind(globalThis);
  }

  /** 1 チャンネルへ投稿する。例外は握りつぶさず結果オブジェクトへ写す (握りつぶし禁止に対応)。 */
  async postMessage(channel: string, message: SlackMessage): Promise<SlackPostResult> {
    try {
      const res = await this.fetchImpl(SLACK_POST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text: message.text, blocks: message.blocks }),
      });
      const body = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
      if (res.ok && body.ok) {
        return { channel, ok: true, ts: body.ts };
      }
      return { channel, ok: false, error: body.error ?? `http_${res.status}` };
    } catch (error) {
      return { channel, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 複数チャンネルへ順に投稿し、すべての結果を返す (個別失敗で止めない)。 */
  async postToChannels(channels: string[], message: SlackMessage): Promise<SlackPostResult[]> {
    const results: SlackPostResult[] = [];
    for (const channel of channels) {
      results.push(await this.postMessage(channel, message));
    }
    return results;
  }
}

/** 要約メッセージ (Block Kit + fallback text) を構築する。 */
export function buildSummaryMessage(input: SummaryMessageInput): SlackMessage {
  const headerTitle = truncate(`要約: ${input.title}`, HEADER_TITLE_MAX);
  const mrkdwn = markdownToMrkdwn(input.summaryMarkdown);
  const summaryChunks = splitForSection(mrkdwn, SECTION_TEXT_MAX);

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headerTitle, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*カテゴリ*\n${input.category}` },
        { type: "mrkdwn", text: `*更新日時*\n${input.updatedAt}` },
      ],
    },
    { type: "divider" },
    ...summaryChunks.map((chunk) => ({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    })),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${input.url}|Notion で開く>` }],
    },
  ];

  const text = truncate(`要約: ${input.title}\n${mrkdwn}`, FALLBACK_TEXT_MAX);
  return { text, blocks };
}

/**
 * Markdown を Slack mrkdwn へ変換する (spec §13)。
 * fenced code block の内側は変換せず維持する。
 */
export function markdownToMrkdwn(markdown: string): string {
  // ```...``` を捕捉して分割。奇数インデックスが code block。
  const segments = markdown.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment, index) => (index % 2 === 1 ? segment : convertNonCode(segment)))
    .join("");
}

function convertNonCode(text: string): string {
  const converted = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^(\s*)#{1,6}\s+(.*)$/);
      if (heading) return `${heading[1]}*${heading[2]}*`;
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (bullet) return `${bullet[1]}• ${bullet[2]}`;
      return line;
    })
    .join("\n");

  // 強調記法を Slack 形式へ。
  let result = converted.replace(/\*\*([^*]+)\*\*/g, "*$1*").replace(/__([^_]+)__/g, "_$1_");

  // `\1` `\2` のような番号プレースホルダを連番へ補正する。
  let counter = 0;
  result = result.replace(/\\\d+/g, () => {
    counter += 1;
    return String(counter);
  });

  return result;
}

/** Slack section の文字数制限に収めるため max 文字単位で分割する (改行優先)。 */
export function splitForSection(text: string, max = SECTION_TEXT_MAX): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [""];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
