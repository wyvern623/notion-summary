/**
 * Notion ブロック → 要約用 Markdown 変換 (spec §11)。
 *
 * notion.ts が (子ブロックを children に付けた状態で) 取得したブロック配列を受け取り、
 * Markdown 文字列へ変換する。子ブロックは深さに応じて半角スペース2個ずつインデント。
 * child_page / child_database は子ブロックを辿らない (spec §10)。
 */

export interface NotionRichText {
  plain_text?: string;
}

export interface NotionBlock {
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: unknown;
}

const INDENT = "  ";

/** ブロック配列を Markdown へ変換する。depth は再帰用 (外部呼び出しは 0)。 */
export function blocksToMarkdown(blocks: NotionBlock[], depth = 0): string {
  const lines: string[] = [];
  let numberCounter = 0;

  for (const block of blocks) {
    if (block.type === "numbered_list_item") {
      numberCounter += 1;
    } else {
      numberCounter = 0;
    }

    const rendered = renderBlock(block, numberCounter);
    if (rendered !== null) {
      lines.push(indentText(rendered, depth));
    }

    const children = block.children;
    if (
      Array.isArray(children) &&
      children.length > 0 &&
      block.type !== "child_page" &&
      block.type !== "child_database"
    ) {
      const childMd = blocksToMarkdown(children, depth + 1);
      if (childMd.length > 0) lines.push(childMd);
    }
  }

  return lines.join("\n");
}

/** 1ブロック自身の Markdown 行を返す。変換不要なら null。 */
function renderBlock(block: NotionBlock, numberIndex: number): string | null {
  const data = getObject(block[block.type]);

  switch (block.type) {
    case "paragraph":
      return richTextToPlain(data);
    case "heading_1":
      return `# ${richTextToPlain(data)}`;
    case "heading_2":
      return `## ${richTextToPlain(data)}`;
    case "heading_3":
      return `### ${richTextToPlain(data)}`;
    case "bulleted_list_item":
      return `- ${richTextToPlain(data)}`;
    case "numbered_list_item":
      return `${numberIndex}. ${richTextToPlain(data)}`;
    case "to_do": {
      const checked = data?.checked === true;
      return `- [${checked ? "x" : " "}] ${richTextToPlain(data)}`;
    }
    case "toggle":
      return `- ${richTextToPlain(data)}`;
    case "quote":
      return `> ${richTextToPlain(data)}`;
    case "callout":
      return `> ${richTextToPlain(data)}`;
    case "code": {
      const language = typeof data?.language === "string" ? data.language : "";
      const text = richTextToPlain(data);
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case "divider":
      return "---";
    case "child_page": {
      const title = typeof data?.title === "string" ? data.title : "タイトルなし";
      return `- [ページ] ${title}`;
    }
    case "child_database": {
      const title = typeof data?.title === "string" ? data.title : "タイトルなし";
      return `- [データベース] ${title}`;
    }
    case "image":
    case "file":
    case "video":
    case "pdf":
    case "embed":
    case "bookmark":
      return renderMedia(block.type, data);
    default: {
      // その他 rich_text を持つブロックはプレーンテキスト。なければ無視。
      const text = richTextToPlain(data);
      return text.length > 0 ? text : null;
    }
  }
}

function renderMedia(type: string, data: Record<string, unknown> | null): string {
  const caption = richTextFrom(data?.caption);
  return caption.length > 0 ? `[${type}: ${caption}]` : `[${type}]`;
}

/** ブロックの type オブジェクトから rich_text を連結する。 */
function richTextToPlain(data: Record<string, unknown> | null): string {
  return richTextFrom(data?.rich_text);
}

function richTextFrom(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((rt) => {
      if (rt && typeof rt === "object" && "plain_text" in rt) {
        const pt = (rt as NotionRichText).plain_text;
        return typeof pt === "string" ? pt : "";
      }
      return "";
    })
    .join("");
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** テキスト (複数行可) を depth ぶんインデントする。 */
function indentText(text: string, depth: number): string {
  if (depth <= 0) return text;
  const prefix = INDENT.repeat(depth);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}
