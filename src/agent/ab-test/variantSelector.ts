// src/agent/ab-test/variantSelector.ts

export interface PromptVariant {
  id: string;
  name: string;
  prompt: string;
  weight: number;
}

export interface VariantSelectionResult {
  prompt: string;
  variantId: string | null;
  variantName: string | null;
}

/**
 * 文字列キーを [0, 1) の決定的な擬似乱数値にハッシュする。
 * 同じキーからは常に同じ値が得られる（sticky assignment用）。
 * src/api/conversion/abTestRoutes.ts の assignVariant と同じ hash*31+charCode パターンを
 * 採用しつつ、2値分岐ではなく連続値 [0,1) が必要なためこちらは独自に実装する
 * （assignVariant自体は既存の呼び出し元・テストへの影響を避けるため変更しない）。
 */
function hashToUnitInterval(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash / 4294967296; // 2^32 で正規化
}

/**
 * テナントのsystem_prompt_variantsからA/B振り分けを行う。
 * - variants が空 or 1つだけ → 既存のfallbackPromptをそのまま使う（後方互換）
 * - variants が2つ以上 → weightに基づいて選択
 * - weight合計が100でない場合は正規化して動作
 *
 * GID 1216978855735482: stickyKey（通常はsession_id）を指定すると、Math.random()の
 * 代わりに決定的ハッシュで選択する。同一セッション内で複数回呼ばれても常に同じvariantに
 * なる（sticky assignment）。stickyKey省略時は従来どおりMath.random()を使う
 * （呼び出し元がsession_idを持たない場合の後方互換フォールバック）。
 */
export function selectVariant(
  variants: PromptVariant[],
  fallbackPrompt: string,
  stickyKey?: string,
): VariantSelectionResult {
  // null/undefined/空配列 → fallbackを返す
  if (!variants || variants.length === 0) {
    return { prompt: fallbackPrompt, variantId: null, variantName: null };
  }

  // 1つだけ → そのvariantを返す
  if (variants.length === 1) {
    const v = variants[0];
    return { prompt: v.prompt, variantId: v.id, variantName: v.name };
  }

  // 2つ以上 → weightを合計して正規化、選択
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight <= 0) {
    // weightが全て0以下の場合は先頭を返す
    const v = variants[0];
    return { prompt: v.prompt, variantId: v.id, variantName: v.name };
  }

  const pseudoRandom = stickyKey ? hashToUnitInterval(stickyKey) : Math.random();
  const rand = pseudoRandom * totalWeight;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.weight;
    if (rand < cumulative) {
      return { prompt: v.prompt, variantId: v.id, variantName: v.name };
    }
  }

  // 浮動小数点の誤差で末尾を超えた場合は最後のvariantを返す
  const last = variants[variants.length - 1];
  return { prompt: last.prompt, variantId: last.id, variantName: last.name };
}
