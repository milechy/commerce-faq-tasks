// src/lib/security/inputSanitizer.ts
// 入力サニタイズ + LLM出力クリーン

// URL検出パターン
const URL_PATTERN =
  /https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.(com|net|org|io|co|jp|xyz|info|biz|dev|app|ai)[/\S]*/gi;

// 拒否するパターン一覧
const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: URL_PATTERN,             reason: "url_not_allowed" },
  { pattern: /<script[\s>]/i,         reason: "blocked_content" },
  { pattern: /javascript:/i,          reason: "blocked_content" },
  { pattern: /data:text\/html/i,      reason: "blocked_content" },
  { pattern: /on\w+\s*=/i,            reason: "blocked_content" },
];

export interface SanitizeResult {
  safe: boolean;
  reason?: string;
  sanitized: string;
}

export function sanitizeInput(text: string): SanitizeResult {
  // 1. 長さチェック（コスト対策）
  if (text.length > 2000) {
    return { safe: false, reason: "message_too_long", sanitized: text };
  }

  // 2. 禁止パターンチェック
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    pattern.lastIndex = 0; // グローバルフラグのリセット
    if (pattern.test(text)) {
      return { safe: false, reason, sanitized: text };
    }
  }

  return { safe: true, sanitized: text.trim() };
}

/** LLM出力からURLを除去（出力サニタイズ） */
export function sanitizeOutput(text: string): string {
  return text.replace(URL_PATTERN, "[リンク削除]");
}

/** ブロック理由 → ユーザー向けメッセージ */
export function blockReasonToMessage(reason: string, lang: "ja" | "en" = "ja"): string {
  const messages: Record<string, Record<string, string>> = {
    url_not_allowed: {
      ja: "URLの送信はセキュリティ上お受けできません。ご質問をテキストでお送りください。",
      en: "For security reasons, URLs are not allowed. Please send your question as plain text.",
    },
    message_too_long: {
      ja: "メッセージが長すぎます。2000文字以内でお送りください。",
      en: "Message is too long. Please keep it under 2000 characters.",
    },
    blocked_content: {
      ja: "送信できない内容が含まれています。",
      en: "Your message contains content that cannot be sent.",
    },
  };
  return messages[reason]?.[lang] ?? messages["blocked_content"]![lang]!;
}
