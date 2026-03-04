// src/agent/avatar/piiRouteDetector.ts

export type PiiRouteReason =
  | "payment_billing"
  | "order_tracking"
  | "address_contact"
  | "credentials"
  | "id_like_token";

export function detectPiiRoute(payload: {
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  intentHint?: string; // "payment" など
}): { isPiiRoute: boolean; reasons: PiiRouteReason[] } {
  const text = [
    payload.userMessage ?? "",
    ...(payload.history ?? []).map((m) => m.content ?? ""),
  ]
    .join(" ")
    .toLowerCase();

  const reasons: PiiRouteReason[] = [];

  // intentHint で先に弾く（SSOTのsales flowは別、ここはpresentation制御のみ）
  if ((payload.intentHint ?? "") === "payment") reasons.push("payment_billing");

  // 支払い/請求/カード
  const paymentKeywords = [
    "カード",
    "クレジット",
    "支払い",
    "決済",
    "請求",
    "invoice",
    "billing",
    "payment",
    "credit card",
    "cvv",
    "cvc",
  ];
  if (paymentKeywords.some((k) => text.includes(k.toLowerCase()))) {
    reasons.push("payment_billing");
  }

  // 住所/連絡先
  const addressKeywords = [
    "住所",
    "郵便番号",
    "電話",
    "電話番号",
    "メール",
    "email",
    "address",
    "zip",
    "postcode",
    "phone",
  ];
  if (addressKeywords.some((k) => text.includes(k.toLowerCase()))) {
    reasons.push("address_contact");
  }

  // 注文/追跡
  const orderKeywords = [
    "注文番号",
    "注文",
    "追跡",
    "配送状況",
    "tracking",
    "order number",
    "shipment",
  ];
  if (orderKeywords.some((k) => text.includes(k.toLowerCase()))) {
    reasons.push("order_tracking");
  }

  // アカウント/認証
  const credKeywords = [
    "パスワード",
    "ログイン",
    "アカウント",
    "password",
    "login",
    "account",
  ];
  if (credKeywords.some((k) => text.includes(k.toLowerCase()))) {
    reasons.push("credentials");
  }

  // IDっぽいトークン（ざっくり）: 連続数字が長い、英数ハイフンが長い等
  // ※厳密にPII抽出しない。あくまで「導線」判定。
  const longDigit = /\b\d{10,}\b/;
  const longToken = /\b[a-z0-9\-]{16,}\b/;
  if (longDigit.test(text) || longToken.test(text)) {
    reasons.push("id_like_token");
  }

  const unique = Array.from(new Set(reasons));
  return { isPiiRoute: unique.length > 0, reasons: unique };
}
