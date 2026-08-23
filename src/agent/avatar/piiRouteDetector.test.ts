// src/agent/avatar/piiRouteDetector.test.ts
// PR-9(R10救出): detectPiiRoute は依存ゼロの純関数だが、これまで自身の単体テストが
// 無かった(到達していたのは死んだ avatarPolicy 経由の avatarIntegration.test.ts のみ)。
// 本番の /api/chat に配線する前提として、各カテゴリの判定を個別に固定する。

import { detectPiiRoute } from "./piiRouteDetector";

describe("detectPiiRoute", () => {
  it("PIIに無関係なメッセージ → isPiiRoute=false, reasons=[]", () => {
    const result = detectPiiRoute({ userMessage: "営業時間を教えてください" });
    expect(result).toEqual({ isPiiRoute: false, reasons: [] });
  });

  it("支払い関連キーワード(クレジットカード) → payment_billing", () => {
    const result = detectPiiRoute({ userMessage: "クレジットカードで支払いたいです" });
    expect(result.isPiiRoute).toBe(true);
    expect(result.reasons).toContain("payment_billing");
  });

  it("英語の支払いキーワード(credit card)も大文字小文字を区別せず検知する", () => {
    const result = detectPiiRoute({ userMessage: "Can I pay by Credit Card?" });
    expect(result.reasons).toContain("payment_billing");
  });

  it("住所/連絡先キーワード(電話番号) → address_contact", () => {
    const result = detectPiiRoute({ userMessage: "電話番号を伝えたいのですが" });
    expect(result.reasons).toContain("address_contact");
  });

  it("注文/追跡キーワード(注文番号) → order_tracking", () => {
    const result = detectPiiRoute({ userMessage: "注文番号を教えてください" });
    expect(result.reasons).toContain("order_tracking");
  });

  it("アカウント/認証キーワード(パスワード) → credentials", () => {
    const result = detectPiiRoute({ userMessage: "パスワードを忘れました" });
    expect(result.reasons).toContain("credentials");
  });

  it("長い連続数字(10桁以上) → id_like_token", () => {
    const result = detectPiiRoute({ userMessage: "注文IDは1234567890123です" });
    expect(result.reasons).toContain("id_like_token");
  });

  it("intentHint='payment' はメッセージ本文に関わらずpayment_billingを検知する", () => {
    const result = detectPiiRoute({ userMessage: "はい", intentHint: "payment" });
    expect(result.reasons).toContain("payment_billing");
  });

  it("history内のメッセージもPII検知の対象に含める", () => {
    const result = detectPiiRoute({
      userMessage: "はい、それでお願いします",
      history: [{ role: "user", content: "パスワードを再設定したい" }],
    });
    expect(result.reasons).toContain("credentials");
  });

  it("複数カテゴリに該当する場合は重複を除いた複数reasonsを返す", () => {
    const result = detectPiiRoute({
      userMessage: "クレジットカードの支払いと、注文番号の確認をお願いします",
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining(["payment_billing", "order_tracking"])
    );
    expect(new Set(result.reasons).size).toBe(result.reasons.length);
  });
});
