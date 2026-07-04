// admin-ui/src/lib/tuningPriority.ts
// チューニングルールの優先度(0〜10の数値)を、非エンジニア向けの3段階表現に変換する。
// GID 1216274385080156: 数値スライダーが分かりにくいという指摘への対応。
// DB/APIは既存互換のため引き続き数値(priority: number)を保持し、UI表示のみ3段階にする。

export type PriorityTier = "low" | "normal" | "high";

// 各段階を選んだときにAPIへ送る代表値
export const PRIORITY_TIER_VALUE: Record<PriorityTier, number> = {
  low: 2,
  normal: 5,
  high: 8,
};

// 既存ルール(0〜10の任意の数値)を3段階に丸めて表示するための閾値
export function priorityToTier(priority: number): PriorityTier {
  if (priority >= 7) return "high";
  if (priority <= 3) return "low";
  return "normal";
}
