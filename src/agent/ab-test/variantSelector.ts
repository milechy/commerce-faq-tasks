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
 * テナントのsystem_prompt_variantsからA/B振り分けを行う。
 * - variants が空 or 1つだけ → 既存のfallbackPromptをそのまま使う（後方互換）
 * - variants が2つ以上 → weightに基づいてランダム選択
 * - weight合計が100でない場合は正規化して動作
 */
export function selectVariant(
  variants: PromptVariant[],
  fallbackPrompt: string,
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

  // 2つ以上 → weightを合計して正規化、ランダム選択
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight <= 0) {
    // weightが全て0以下の場合は先頭を返す
    const v = variants[0];
    return { prompt: v.prompt, variantId: v.id, variantName: v.name };
  }

  const rand = Math.random() * totalWeight;
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
