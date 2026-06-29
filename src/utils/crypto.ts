/**
 * Notion Webhook の署名検証 (spec §16 / 計画 §4-A)。
 *
 * Notion は通常イベントで `X-Notion-Signature: sha256=<hex HMAC>` を送る。
 * HMAC は verification_token (= NOTION_WEBHOOK_TOKEN) を鍵に、
 * **生リクエストボディ文字列**を HMAC-SHA256 した値。
 * 検証は必ず raw body で行い、JSON 再シリアライズした文字列では行わない。
 */

const encoder = new TextEncoder();

/** raw body を token を鍵に HMAC-SHA256 し、小文字 hex 文字列を返す。 */
export async function computeHmacSha256Hex(token: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return bufferToHex(signature);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** タイミング攻撃を避けるための定数時間比較。長さが違えば即 false だが、内容差は時間に漏らさない。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * `X-Notion-Signature` ヘッダ値を検証する。
 * 期待形式は `sha256=<hex>`。ヘッダ欠如・形式不正・不一致はすべて false。
 */
export async function verifyNotionSignature(
  token: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length).trim().toLowerCase();
  if (provided.length === 0) return false;
  const expected = await computeHmacSha256Hex(token, rawBody);
  return timingSafeEqual(provided, expected);
}
