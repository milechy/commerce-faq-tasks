// src/lib/billing/costCalculator.test.ts
// Phase32: コスト計算の精度検証

import {
  calculateLLMCostCents,
  calculateBillingAmountCents,
  calculateTTSCostCents,
  calculateAvatarCostCents,
  normalizeModelKey,
  LLM_COSTS,
  SERVER_COST_PER_REQUEST_USD,
  MARGIN_MULTIPLIER,
  FISH_AUDIO_COST_PER_BYTE_USD,
  LEMONSLICE_COST_PER_CREDIT_USD,
  IMAGE_GENERATION_COST_USD,
  END_USER_FEATURES,
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
// Phase40: calculateTTSCostCents
// ---------------------------------------------------------------------------
describe('calculateTTSCostCents', () => {
  it('0バイトは 0 を返す', () => {
    expect(calculateTTSCostCents(0)).toBe(0);
  });

  it('1,000,000バイト = $15.00 = 1500 cents', () => {
    // 1_000_000 * 15.0 / 1_000_000 * 100 = 1500 (exact)
    expect(calculateTTSCostCents(1_000_000)).toBe(1500);
  });

  it('300バイト（日本語100文字相当）→ Math.ceil', () => {
    // 300 * 15.0 / 1_000_000 * 100 = 0.045 cents → Math.ceil = 1
    expect(calculateTTSCostCents(300)).toBe(1);
  });

  it('整数を返す', () => {
    expect(Number.isInteger(calculateTTSCostCents(12345))).toBe(true);
  });

  it('負の値は例外を投げる', () => {
    expect(() => calculateTTSCostCents(-1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase40: calculateAvatarCostCents
// ---------------------------------------------------------------------------
describe('calculateAvatarCostCents', () => {
  it('0クレジットは 0 を返す', () => {
    expect(calculateAvatarCostCents(0)).toBe(0);
  });

  it('1000クレジット = $7.00 = 700 cents', () => {
    // 1000 * 7.0 / 1000 * 100 = 700 (exact)
    expect(calculateAvatarCostCents(1000)).toBe(700);
  });

  it('6クレジット → Math.ceil', () => {
    // 6 * 7.0 / 1000 * 100 = 4.2 cents → Math.ceil = 5
    expect(calculateAvatarCostCents(6)).toBe(5);
  });

  it('整数を返す', () => {
    expect(Number.isInteger(calculateAvatarCostCents(57))).toBe(true);
  });

  it('負の値は例外を投げる', () => {
    expect(() => calculateAvatarCostCents(-1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase40: calculateBillingAmountCents with TTS/Avatar
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents with TTS/Avatar', () => {
  it('ttsTextBytes のみ追加: コストが増加する', () => {
    const base = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
    });
    const withTTS = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      ttsTextBytes: 1_000_000,
    });
    expect(withTTS).toBeGreaterThan(base);
  });

  it('avatarCredits のみ追加: コストが増加する', () => {
    const base = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
    });
    const withAvatar = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      avatarCredits: 100,
    });
    expect(withAvatar).toBeGreaterThan(base);
  });

  it('ttsTextBytes=0, avatarCredits=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 100, outputTokens: 50,
    });
    const withZero = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 100, outputTokens: 50,
      ttsTextBytes: 0, avatarCredits: 0,
    });
    expect(withZero).toBe(base);
  });

  it('マージンが TTS/Avatarコストにも適用される', () => {
    // 1M TTSバイト = $15.00 USD、margin=5 → $75 = 7500 cents
    // + SERVER_COST (0.0001 * 5 * 100 = 0.05 → ceil=1)
    // total = Math.ceil((15.0 + 0.0001) * 5 * 100) = Math.ceil(7500.05) = 7501
    const result = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      ttsTextBytes: 1_000_000,
    });
    expect(result).toBeGreaterThanOrEqual(7500);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase53: feature-based margin（END_USER_FEATURES vs admin features）
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents: feature-based margin', () => {
  const baseParams = {
    model: 'llama-3.1-8b-instant',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };

  it('featureUsed 未指定 → 後方互換: MARGIN_MULTIPLIER 適用', () => {
    const result = calculateBillingAmountCents(baseParams);
    // 既存テストと同じ: llmUSD=0.13, total=0.1301, billing=Math.ceil(0.1301 * 5 * 100) = 66
    expect(result).toBe(66);
  });

  it('featureUsed: chat → エンドユーザー = MARGIN_MULTIPLIER 適用', () => {
    const withFeature = calculateBillingAmountCents({ ...baseParams, featureUsed: 'chat' });
    const withoutFeature = calculateBillingAmountCents(baseParams);
    expect(withFeature).toBe(withoutFeature);
  });

  it('featureUsed: avatar → エンドユーザー = MARGIN_MULTIPLIER 適用', () => {
    const withFeature = calculateBillingAmountCents({ ...baseParams, featureUsed: 'avatar' });
    const withoutFeature = calculateBillingAmountCents(baseParams);
    expect(withFeature).toBe(withoutFeature);
  });

  it('featureUsed: feedback_ai → 管理機能 = margin × 1（原価のみ）', () => {
    const adminResult = calculateBillingAmountCents({ ...baseParams, featureUsed: 'feedback_ai' });
    const endUserResult = calculateBillingAmountCents({ ...baseParams, featureUsed: 'chat' });
    // 管理機能は margin=1、エンドユーザー機能は MARGIN_MULTIPLIER（デフォルト5）
    expect(adminResult).toBeLessThan(endUserResult);
    // adminResult ≈ llmUSD + serverCost = 0.13 + 0.0001 = 0.1301 USD → Math.ceil(13.01) = 14 cents
    expect(adminResult).toBe(14);
  });

  it('featureUsed: avatar_config_image → 管理機能 = margin × 1', () => {
    const result = calculateBillingAmountCents({ ...baseParams, featureUsed: 'avatar_config_image' });
    expect(result).toBe(14); // 原価のみ
  });

  it('featureUsed: book_structurize → 管理機能 = margin × 1', () => {
    const result = calculateBillingAmountCents({ ...baseParams, featureUsed: 'book_structurize' });
    expect(result).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Phase53: imageCount コスト組み込み
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents: imageCount', () => {
  it('imageCount=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
    });
    const withZero = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0, imageCount: 0,
    });
    expect(withZero).toBe(base);
  });

  it('imageCount=1: $0.04 の画像コストが加算される', () => {
    // featureUsed=avatar_config_image（管理機能=×1）
    // serverCost=0.0001, imageCost=0.04 → total=0.0401 USD → Math.ceil(4.01) = 5 cents
    const result = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      featureUsed: 'avatar_config_image', imageCount: 1,
    });
    expect(result).toBe(5);
  });

  it('imageCount=4: 4枚分のコストが加算される', () => {
    // serverCost=0.0001, imageCost=4*0.04=0.16 → total=0.1601 USD → Math.ceil(16.01) = 17 cents
    const result = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      featureUsed: 'avatar_config_image', imageCount: 4,
    });
    expect(result).toBe(17);
  });

  it('imageCount 未指定は undefined と同じ（コスト0）', () => {
    const a = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 100, outputTokens: 50,
    });
    const b = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 100, outputTokens: 50, imageCount: undefined,
    });
    expect(a).toBe(b);
  });

  it('整数を返す', () => {
    const result = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      imageCount: 3,
    });
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase53: END_USER_FEATURES 定数チェック
// ---------------------------------------------------------------------------
describe('END_USER_FEATURES', () => {
  it('chat / avatar / voice が含まれる', () => {
    expect(END_USER_FEATURES.has('chat')).toBe(true);
    expect(END_USER_FEATURES.has('avatar')).toBe(true);
    expect(END_USER_FEATURES.has('voice')).toBe(true);
  });

  it('管理機能は含まれない', () => {
    expect(END_USER_FEATURES.has('feedback_ai')).toBe(false);
    expect(END_USER_FEATURES.has('avatar_config_image')).toBe(false);
    expect(END_USER_FEATURES.has('book_structurize')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase53: IMAGE_GENERATION_COST_USD 定数チェック
// ---------------------------------------------------------------------------
describe('IMAGE_GENERATION_COST_USD', () => {
  it('$0.04/枚 であること', () => {
    expect(IMAGE_GENERATION_COST_USD).toBeCloseTo(0.04);
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

  it('FISH_AUDIO_COST_PER_BYTE_USD は $15/1M バイト', () => {
    expect(FISH_AUDIO_COST_PER_BYTE_USD).toBeCloseTo(15.0 / 1_000_000);
  });

  it('LEMONSLICE_COST_PER_CREDIT_USD は $7/1000 クレジット', () => {
    expect(LEMONSLICE_COST_PER_CREDIT_USD).toBeCloseTo(7.0 / 1_000);
  });
});
