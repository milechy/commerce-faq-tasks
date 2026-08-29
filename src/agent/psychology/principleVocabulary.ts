// src/agent/psychology/principleVocabulary.ts
// 心理学原則名の単一の出どころ。
//
// なぜ切り出したか(2026-08-29 継ぎ目バグ調査):
// principleDetector.ts の KEYWORD_MAP のキーが事実上の正典だったが、
// bookStructurizerPrompt.md は原則名を自由記述させており、両者を突き合わせる
// 場所が無かった。検出器が返す「返報性」に対し書籍抽出は「返報性の原理」を
// 返すなど、語彙が独立に揺れて searchPrincipleChunks の完全一致検索が
// 永久にヒットしない状態になっていた(.claude/rules/knowledge.md 参照)。
//
// この定数を検出(principleDetector.ts)・抽出プロンプト(bookStructurizerPrompt.md
// へ差し込む側 = bookStructurizer.ts)・検索の3箇所から参照させ、
// 語彙をここ1箇所に固定する。

export const PRINCIPLE_NAMES = [
  "アンカリング効果",
  "損失回避",
  "社会的証明",
  "希少性",
  "コミットメントと一貫性",
  "フレーミング効果",
  "返報性",
] as const;

export type PrincipleName = (typeof PRINCIPLE_NAMES)[number];

/** 値が既知の原則名かどうか。書籍抽出時のガード・LLMフォールバック時の検証に使う。 */
export function isKnownPrinciple(value: string): value is PrincipleName {
  return (PRINCIPLE_NAMES as readonly string[]).includes(value);
}
