// src/api/widget/shopifyHmac.ts
//
// Shopify Webhook 共通の HMAC-SHA256 検証ヘルパー。
// 対象: app/uninstalled と GDPR 必須3種(customers/data_request /
// customers/redact / shop/redact)。全てこの1関数を通す(各ハンドラで
// 個別実装しない。docs/SHOPIFY_APP_REQUIREMENTS.md §11.2)。
//
// Shopify の検証方式(shopify.dev「Verify webhooks」で標準化されている手順):
//   1. raw request body の HMAC-SHA256 を計算し base64 化する
//   2. X-Shopify-Hmac-Sha256 ヘッダの値と一致するかを timing-safe に比較する
//
// 既存の src/lib/crypto/hmacVerifier.ts は内部API向け(タイムスタンプ付き・
// hex署名)で Shopify のプロトコル(タイムスタンプ無し・base64署名)と異なる
// ため流用しない。両者は別プロトコルであり、統合すると片方の変更が
// 意図せずもう片方に波及する。
//
// secret が未設定の場合は fail-closed で検証失敗として扱う(CLAUDE.md 禁止26)。

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyShopifyWebhookHmacParams {
  /** express.json() 適用前の raw body。文字列化済みでも Buffer でもよい。 */
  rawBody: string | Buffer;
  /** X-Shopify-Hmac-Sha256 ヘッダの値。 */
  hmacHeader: string | undefined | null;
  /** Webhook secret(Partner Dashboard の Client Secret)。未設定なら必ず失敗させる。 */
  secret: string | undefined | null;
}

/**
 * Shopify Webhook の HMAC 署名を検証する。純粋関数。
 * secret 未設定・hmacHeader 欠落・空文字列・署名不一致はすべて false を返す。
 */
export function verifyShopifyWebhookHmac(params: VerifyShopifyWebhookHmacParams): boolean {
  const { rawBody, hmacHeader, secret } = params;

  // fail-closed: secret 未設定は「検証できない」ではなく「検証失敗」として扱う。
  if (!secret) {
    return false;
  }
  if (!hmacHeader) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(hmacHeader, "utf8");

  // timingSafeEqual は長さが異なると例外を投げるため、長さ不一致は
  // ここで早期に false へ倒す(改ざんで長さが変わったケースを含む)。
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}
