// src/lib/security/piiPatterns.ts
//
// メールアドレス検出の唯一の情報源。src/middleware/outputGuard.ts(L8, LLM出力からの
// メールアドレス除去)と src/api/hermes-mcp/hermesMcpRepository.ts(社外VPSへ出す前の
// URLパスの伏字化)の両方が同じ正規表現を必要とするため、ここに集約する。
//
// 電話番号・郵便番号のパターンはここに含めない。URLパスには商品ID・注文ID等の
// 数字-数字形式が頻出し、outputGuard.ts の phone_hyphen(\d{2,4}-\d{2,4}-\d{4})や
// postal_code(\d{3}-\d{4})をURLパスに適用すると、Hermesの分析に必要な識別子まで
// 誤って伏字化してしまう。メールアドレスは記号(@)を含み誤検知がほぼ無いため、
// URLパスへの適用でも安全側に倒せる。

/** メールアドレス形状の文字列にマッチする(global フラグ付き)。 */
export const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const EMAIL_REDACTED = "[個人情報のため非表示]";

/** 文字列中のメールアドレス形状の部分文字列を伏字化する。マッチが無ければそのまま返す。 */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, EMAIL_REDACTED);
}
