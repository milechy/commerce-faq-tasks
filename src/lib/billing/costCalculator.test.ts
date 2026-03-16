// src/lib/billing/costCalculator.test.ts
// Phase32: コスト計算の精度検証

import {
  calculateLLMCostCents,
  calculateBillingAmountCents,
  normalizeModelKey,
  LLM_COSTS,
  SERVER_COST_PER_REQUEST_USD,
  MARGIN_MULTIPLIER,
} from './costCalculator';

// ---------------------------------------------------------------------------
// normalizeModelKey
// ---------------------------------------------------------------------------
describe('normalizeModelKey', () => {
  it('llama系は groq-8b に正規化する', () => {
    expect(normalizeModelKey('llama-3.1-8b-instant')).toBe('groq-8b');
    expect(normalizeModelKey('llama3-8b-8192')).toBe('groq-8b');
    expect(normalizeModelKey('gemma-7b-it')).toBe('groq-8b');
  });

  it('70b / mixtral系は groq-70b に正規化する', () => {
    expect(normalizeModelKey('llama-3.1-70b-versatile')).toBe('groq-70b');
    expect(normalizeModelKey('mixtral-8x7b-32768')).toBe('groq-70b');
  });

  it('embedding系は openai-embedding に正規化する', () => {
    expect(normalizeModelKey('text-embedding-3-small')).toBe('openai-embedding');
    expect(normalizeModelKey('openai-embedding-ada')).toBe('openai-embedding');
  });

  it('不明モデルは undefined を返す', () => {
    expect(normalizeModelKey('unknown-model-v99')).toBeUndefined();
    expect(normalizeModelKey('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// calculateLLMCostCents
// ---------------------------------------------------------------------------
describe('calculateLLMCostCents', () => {
  describe('groq-8b', () => {
    it('1000 input + 500 output tokens のコストが正確', () => {
      // input: 1000 * 0.05 / 1_000_000 = 0.00005 USD
      // output: 500 * 0.08 / 1_000_000 = 0.00004 USD
      // total: 0.00009 USD = 0.009 cents → Math.ceil(0.009) = 1
      const result = calculateLLMCostCents({
        model:        'llama-3.1-8b-instant',
        inputTokens:  1000,
        outputTokens: 500,
      });
      expect(result).toBe(1);
    });

    it('1,000,000 input + 1,000,000 output tokens（端数なし）', () => {
      // input: 1_000_000 * 0.05 / 1_000_000 = $0.05 = 5 cents (exact)
      // output: 1_000_000 * 0.08 / 1_000_000 = $0.08 = 8 cents (exact)
      // total: 13 cents → Math.ceil(13) = 13
      const result = calculateLLMCostCents({
        model:        'llama-3.1-8b-instant',
        inputTokens:  1_000_000,
        outputTokens: 1_000_000,
      });
      expect(result).toBe(13);
    });
  });

  describe('groq-70b', () => {
    it('1000 input + 500 output tokens のコストが正確', () => {
      // input: 1000 * 0.59 / 1_000_000 = 0.00059 USD
      // output: 500 * 0.79 / 1_000_000 = 0.000395 USD
      // total: 0.000985 USD = 0.0985 cents → Math.ceil(0.0985) = 1
      const result = calculateLLMCostCents({
        model:        'llama-3.1-70b-versatile',
        inputTokens:  1000,
        outputTokens: 500,
      });
      expect(result).toBe(1);
    });

    it('1,000,000 input + 500,000 output tokens（切り上げあり）', () => {
      // input: 1_000_000 * 0.59 / 1_000_000 = $0.59 = 59 cents
      // output: 500_000 * 0.79 / 1_000_000 = $0.395 = 39.5 cents
      // total: 98.5 cents → Math.ceil(98.5) = 99
      const result = calculateLLMCostCents({
        model:        'llama-3.1-70b-versatile',
        inputTokens:  1_000_000,
        outputTokens: 500_000,
      });
      expect(result).toBe(99);
    });
  });

  describe('openai-embedding', () => {
    it('output は無料（outputPerMillion = 0）', () => {
      // input: 1_000_000 * 0.02 / 1_000_000 = $0.02 = 2 cents
      // output: 0
      const result = calculateLLMCostCents({
        model:        'text-embedding-3-small',
        inputTokens:  1_000_000,
        outputTokens: 999_999,
      });
      expect(result).toBe(2);
    });
  });

  describe('エッジケース', () => {
    it('ゼロトークンは 0 を返す', () => {
      expect(calculateLLMCostCents({ model: 'llama-3.1-70b-versatile', inputTokens: 0, outputTokens: 0 })).toBe(0);
    });

    it('不明モデルは 0 を返す', () => {
      expect(calculateLLMCostCents({ model: 'unknown-model', inputTokens: 1000, outputTokens: 500 })).toBe(0);
    });

    it('負のトークン数は例外を投げる', () => {
      expect(() =>
        calculateLLMCostCents({ model: 'llama-3.1-8b-instant', inputTokens: -1, outputTokens: 0 })
      ).toThrow();
      expect(() =>
        calculateLLMCostCents({ model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: -1 })
      ).toThrow();
    });

    it('整数を返す（小数にならない）', () => {
      const result = calculateLLMCostCents({
        model:        'llama-3.1-70b-versatile',
        inputTokens:  12345,
        outputTokens: 6789,
      });
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// calculateBillingAmountCents
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents', () => {
  it('最小課金: ゼロトークン → サーバーコストのみ × マージン', () => {
    // (0 + 0.0001) * 2 * 100 = 0.02 cents → Math.ceil = 1
    const result = calculateBillingAmountCents({
      model:        'llama-3.1-8b-instant',
      inputTokens:  0,
      outputTokens: 0,
    });
    expect(result).toBe(1);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('groq-8b (1000/500): マージン適用後の金額が正確', () => {
    // llmUSD  = 0.00009
    // total   = 0.00009 + 0.0001 = 0.00019 USD
    // billing = Math.ceil(0.00019 * 2 * 100) = Math.ceil(0.038) = 1
    const result = calculateBillingAmountCents({
      model:        'llama-3.1-8b-instant',
      inputTokens:  1000,
      outputTokens: 500,
    });
    expect(result).toBe(1);
  });

  it('groq-70b (1M/500K): 大きなトークン数でマージン適用が正確', () => {
    // llmUSD  = 0.985
    // total   = 0.985 + 0.0001 = 0.9851 USD
    // billing = Math.ceil(0.9851 * 5 * 100) = Math.ceil(492.55) = 493
    const result = calculateBillingAmountCents({
      model:        'llama-3.1-70b-versatile',
      inputTokens:  1_000_000,
      outputTokens: 500_000,
    });
    expect(result).toBe(493);
  });

  it('groq-8b (1M/1M): 端数なしケースでも正確', () => {
    // llmUSD  = 0.13 (exact)
    // total   = 0.13 + 0.0001 = 0.1301 USD
    // billing = Math.ceil(0.1301 * 5 * 100) = Math.ceil(65.05) = 66
    const result = calculateBillingAmountCents({
      model:        'llama-3.1-8b-instant',
      inputTokens:  1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result).toBe(66);
  });

  it('常に MARGIN_MULTIPLIER × 2 が適用される（サーバーコスト込み）', () => {
    const usage = { model: 'llama-3.1-8b-instant', inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const billingCents = calculateBillingAmountCents(usage);
    const llmCents     = calculateLLMCostCents(usage);

    // billing >= llmCents * MARGIN_MULTIPLIER（サーバーコスト分で多い）
    expect(billingCents).toBeGreaterThanOrEqual(llmCents * MARGIN_MULTIPLIER);
  });

  it('負のトークン数は例外を投げる', () => {
    expect(() =>
      calculateBillingAmountCents({ model: 'llama-3.1-8b-instant', inputTokens: -1, outputTokens: 0 })
    ).toThrow();
  });

  it('整数を返す（セント単位）', () => {
    const result = calculateBillingAmountCents({
      model:        'llama-3.1-70b-versatile',
      inputTokens:  99_999,
      outputTokens: 55_555,
    });
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 定数の整合性チェック
// ---------------------------------------------------------------------------
describe('定数', () => {
  it('LLM_COSTS の全モデルに非負のコストが設定されている', () => {
    for (const [key, cost] of Object.entries(LLM_COSTS)) {
      expect(cost.inputPerMillion).toBeGreaterThanOrEqual(0);
      expect(cost.outputPerMillion).toBeGreaterThanOrEqual(0);
      // 少なくとも input か output のどちらかは有料
      expect(cost.inputPerMillion + cost.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it('SERVER_COST_PER_REQUEST_USD は正の値', () => {
    expect(SERVER_COST_PER_REQUEST_USD).toBeGreaterThan(0);
  });

  it('MARGIN_MULTIPLIER >= 1', () => {
    expect(MARGIN_MULTIPLIER).toBeGreaterThanOrEqual(1);
  });
});
