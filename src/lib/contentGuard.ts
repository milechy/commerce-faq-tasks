/**
 * contentGuard.ts — 著作権/NSFW防止ガード (Phase5-D)
 *
 * NOTE: admin-ui/src/lib/contentGuard.ts と同内容を維持すること。
 *       フロント・バックの両方でインポートして二重防御を実現する。
 */

export const BANNED_WORDS: readonly string[] = [
  // NSFW
  "nude", "naked", "sexy", "nsfw",
  "アダルト", "裸", "セクシー", "エロ", "ヌード",
  // Celebrity / resemblance patterns
  "look like", "resembling", "に似た",
  // Copyrighted characters
  "anime character", "manga",
  "ディズニー", "disney",
  "ピカチュウ", "pikachu", "pokemon", "ポケモン",
  "マリオ", "mario",
  "ドラえもん", "doraemon",
  "ミッキー", "mickey",
  "ナルト", "naruto",
];

/**
 * 禁止ワードが含まれていれば true を返す（大文字小文字無視）
 */
export function containsBannedWord(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_WORDS.some((w) => lower.includes(w.toLowerCase()));
}
