// src/api/widget/shopifyHmac.test.ts
//
// docs/SHOPIFY_APP_REQUIREMENTS.md 受け入れ条件 C-1 / X-1(HMAC 検証に
// 失敗した Webhook リクエストは拒否される)を固定する。

import { createHmac } from "node:crypto";
import { verifyShopifyWebhookHmac } from "./shopifyHmac";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ shop_domain: "example.myshopify.com" });

function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifyShopifyWebhookHmac", () => {
  it("正しい署名は検証に成功する", () => {
    const hmacHeader = signBody(SECRET, BODY);
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader, secret: SECRET })
    ).toBe(true);
  });

  it("Buffer の rawBody でも検証に成功する", () => {
    const bodyBuffer = Buffer.from(BODY, "utf8");
    const hmacHeader = signBody(SECRET, BODY);
    expect(
      verifyShopifyWebhookHmac({ rawBody: bodyBuffer, hmacHeader, secret: SECRET })
    ).toBe(true);
  });

  it("改ざんされた署名(末尾を書き換え)は失敗する", () => {
    const hmacHeader = signBody(SECRET, BODY);
    const tampered = hmacHeader.slice(0, -1) + (hmacHeader.endsWith("A") ? "B" : "A");
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader: tampered, secret: SECRET })
    ).toBe(false);
  });

  it("別のsecretで署名されたリクエストは失敗する", () => {
    const hmacHeader = signBody("wrong-secret", BODY);
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader, secret: SECRET })
    ).toBe(false);
  });

  it("bodyが改ざんされていると失敗する(署名は元bodyのまま)", () => {
    const hmacHeader = signBody(SECRET, BODY);
    const tamperedBody = JSON.stringify({ shop_domain: "attacker.myshopify.com" });
    expect(
      verifyShopifyWebhookHmac({ rawBody: tamperedBody, hmacHeader, secret: SECRET })
    ).toBe(false);
  });

  it("hmacHeaderが空文字列なら失敗する", () => {
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader: "", secret: SECRET })
    ).toBe(false);
  });

  it("hmacHeaderがundefinedなら失敗する", () => {
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader: undefined, secret: SECRET })
    ).toBe(false);
  });

  it("hmacHeaderがnullなら失敗する", () => {
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader: null, secret: SECRET })
    ).toBe(false);
  });

  it("secretが未設定(undefined)ならfail-closedで失敗する(正しい署名でも通さない)", () => {
    const hmacHeader = signBody(SECRET, BODY);
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader, secret: undefined })
    ).toBe(false);
  });

  it("secretが空文字列でもfail-closedで失敗する", () => {
    const hmacHeader = signBody(SECRET, BODY);
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader, secret: "" })
    ).toBe(false);
  });

  it("secretがnullでもfail-closedで失敗する", () => {
    const hmacHeader = signBody(SECRET, BODY);
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader, secret: null })
    ).toBe(false);
  });

  it("長さの異なる不正な署名文字列は例外を投げずfalseを返す", () => {
    expect(
      verifyShopifyWebhookHmac({ rawBody: BODY, hmacHeader: "short", secret: SECRET })
    ).toBe(false);
  });
});
