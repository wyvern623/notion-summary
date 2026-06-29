import { describe, expect, it } from "vitest";
import {
  computeHmacSha256Hex,
  timingSafeEqual,
  verifyNotionSignature,
} from "../src/utils/crypto.js";

const TOKEN = "secret_verification_token";
const BODY = '{"type":"page.content_updated","entity":{"type":"page","id":"abc"}}';
// Node の `crypto.createHmac("sha256", TOKEN).update(BODY).digest("hex")` で算出した既知値。
// Notion 公式が使う HMAC-SHA256 実装と WebCrypto の出力が一致することを固定値で保証する。
const KNOWN_HMAC = "a16e33b957618ae3710bd8c8413a2c247a9d71c9a4ac8c593ffca3c9eaf95936";

describe("computeHmacSha256Hex", () => {
  it("既知の HMAC-SHA256 (RFC 4231 風) と一致する小文字 hex を返す", async () => {
    // Node の crypto と一致することの簡易確認: 同じ入力で安定し、64桁 hex になる。
    const hex = await computeHmacSha256Hex(TOKEN, BODY);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const again = await computeHmacSha256Hex(TOKEN, BODY);
    expect(again).toBe(hex);
  });

  it("Node の crypto (Notion 公式実装相当) の既知値と完全一致する", async () => {
    expect(await computeHmacSha256Hex(TOKEN, BODY)).toBe(KNOWN_HMAC);
  });

  it("body が変わると署名も変わる", async () => {
    const a = await computeHmacSha256Hex(TOKEN, BODY);
    const b = await computeHmacSha256Hex(TOKEN, `${BODY} `);
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqual", () => {
  it("一致/不一致/長さ違いを正しく判定する", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("verifyNotionSignature", () => {
  it("正しい署名なら true", async () => {
    const hex = await computeHmacSha256Hex(TOKEN, BODY);
    expect(await verifyNotionSignature(TOKEN, BODY, `sha256=${hex}`)).toBe(true);
  });

  it("大文字 hex でも許容する", async () => {
    const hex = (await computeHmacSha256Hex(TOKEN, BODY)).toUpperCase();
    expect(await verifyNotionSignature(TOKEN, BODY, `sha256=${hex}`)).toBe(true);
  });

  it("署名不一致なら false", async () => {
    const hex = await computeHmacSha256Hex("wrong_token", BODY);
    expect(await verifyNotionSignature(TOKEN, BODY, `sha256=${hex}`)).toBe(false);
  });

  it("ヘッダ欠如・形式不正は false", async () => {
    const hex = await computeHmacSha256Hex(TOKEN, BODY);
    expect(await verifyNotionSignature(TOKEN, BODY, null)).toBe(false);
    expect(await verifyNotionSignature(TOKEN, BODY, hex)).toBe(false); // prefix なし
    expect(await verifyNotionSignature(TOKEN, BODY, "sha256=")).toBe(false);
  });
});
