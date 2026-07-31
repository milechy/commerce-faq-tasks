// src/api/admin/tuning/triggerMatching.ts
// 指示ルール(tuning_rules)の発火条件判定。DB・ネットワークに触れない純関数。
//
// 旧UI(/admin/tuning)経由で保存されたルールと、チャット(/copilot-preview)経由で
// 保存されたルールが、同じ質問文に対して同じ発火可否を返すことを保証するため、
// この判定は1箇所にのみ実装する(2箇所に複製すると挙動が割れる。
// CLAUDE.md「指示ルール(tuning_rules)の不変ルール」)。
//
// 発火条件の可視化(下書きカードでの提示)も getMatchingKeywords の結果を使うこと。
// 判定と可視化が別ロジックだと、カードには出ない条件で発火する/しないという
// 食い違いが起こる。

// trigger_pattern の区切り文字: 半角カンマ・全角カンマ・読点(、)
const DELIMITER_RE = /[,，、]/;

// カタカナ(U+30A1-U+30F6) → ひらがな(U+3041-U+3096)への折り畳み。
// NFKC は全角英数・半角カナ等は正規化するが、カタカナ⇔ひらがなは変換しないため別途行う。
function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function normalize(s: string): string {
  return katakanaToHiragana(s.normalize('NFKC')).toLowerCase().trim();
}

/** trigger_pattern をキーワード配列に分割する(空要素・前後空白は除去)。 */
export function splitTriggerKeywords(triggerPattern: string): string[] {
  return triggerPattern
    .split(DELIMITER_RE)
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * クエリ文字列に対して実際に発火するキーワードを返す(0件なら不一致)。
 * 表記ゆれ(全角半角・ひらがな/カタカナ)は正規化した上で部分一致を取る。
 */
export function getMatchingKeywords(query: string, triggerPattern: string): string[] {
  const normalizedQuery = normalize(query);
  return splitTriggerKeywords(triggerPattern).filter((k) => normalizedQuery.includes(normalize(k)));
}

/** チューニングルールのトリガーパターンがクエリにマッチするか判定する。 */
export function matchesTriggerPattern(query: string, triggerPattern: string): boolean {
  return getMatchingKeywords(query, triggerPattern).length > 0;
}
