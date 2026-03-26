// src/agent/ab-test/variantSelector.test.ts

import { selectVariant } from './variantSelector';
import type { PromptVariant } from './variantSelector';

const variantA: PromptVariant = { id: 'variant_a', name: '標準版', prompt: 'プロンプトA', weight: 70 };
const variantB: PromptVariant = { id: 'variant_b', name: '積極版', prompt: 'プロンプトB', weight: 30 };

describe('selectVariant', () => {
  it('weight [70, 30] → 統計的に70%の確率でvariant_a（1000回実行で60-80%の範囲）', () => {
    const counts: Record<string, number> = { variant_a: 0, variant_b: 0 };
    for (let i = 0; i < 1000; i++) {
      const result = selectVariant([variantA, variantB], 'fallback');
      if (result.variantId) {
        counts[result.variantId] = (counts[result.variantId] ?? 0) + 1;
      }
    }
    const ratioA = counts['variant_a']! / 1000;
    expect(ratioA).toBeGreaterThan(0.60);
    expect(ratioA).toBeLessThan(0.80);
  });

  it('variantsが空配列 → fallbackPromptを返す、variantId=null', () => {
    const result = selectVariant([], 'fallback-prompt');
    expect(result.prompt).toBe('fallback-prompt');
    expect(result.variantId).toBeNull();
    expect(result.variantName).toBeNull();
  });

  it('variantsが1つ → そのvariantを常に返す、variantId=variant_idの値', () => {
    const single: PromptVariant = { id: 'only_variant', name: '唯一版', prompt: '唯一プロンプト', weight: 100 };
    for (let i = 0; i < 10; i++) {
      const result = selectVariant([single], 'fallback');
      expect(result.prompt).toBe('唯一プロンプト');
      expect(result.variantId).toBe('only_variant');
      expect(result.variantName).toBe('唯一版');
    }
  });

  it('weight合計が100でない（[60, 20]）→ 正規化して動作（合計80のうちの比率）', () => {
    const vA: PromptVariant = { id: 'variant_a', name: 'A', prompt: 'A', weight: 60 };
    const vB: PromptVariant = { id: 'variant_b', name: 'B', prompt: 'B', weight: 20 };
    const counts: Record<string, number> = { variant_a: 0, variant_b: 0 };
    for (let i = 0; i < 1000; i++) {
      const result = selectVariant([vA, vB], 'fallback');
      if (result.variantId) {
        counts[result.variantId] = (counts[result.variantId] ?? 0) + 1;
      }
    }
    // 期待: variant_a が 60/80 = 75%, variant_b が 20/80 = 25%
    const ratioA = counts['variant_a']! / 1000;
    expect(ratioA).toBeGreaterThan(0.65);
    expect(ratioA).toBeLessThan(0.85);
  });

  it('chat_sessionsへのvariant_id/variant_name記録のためのヘルパー動作確認', () => {
    const result = selectVariant([variantA, variantB], 'fallback');
    // variantId と variantName が文字列であること（DBカラムに記録できる型）
    expect(typeof result.variantId).toBe('string');
    expect(typeof result.variantName).toBe('string');
    expect(typeof result.prompt).toBe('string');
    // variantId が variants のいずれかの id と一致すること
    const validIds = [variantA.id, variantB.id];
    expect(validIds).toContain(result.variantId);
  });
});
