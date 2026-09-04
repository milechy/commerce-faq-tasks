// src/lib/billing/costCalculator.test.ts
// Phase32: コスト計算の精度検証

import {
  calculateLLMCostCents,
  calculateBillingAmountCents,
  calculateBaseCostCents,
  calculateTTSCostCents,
  calculateAvatarCostCents,
  fishTtsCostPerByteUsd,
  normalizeModelKey,
  LLM_COSTS,
  SERVER_COST_PER_REQUEST_USD,
  MARGIN_MULTIPLIER,
  FISH_AUDIO_COST_PER_BYTE_USD,
  LEMONSLICE_COST_PER_CREDIT_USD,
  IMAGE_GENERATION_COST_USD,
  END_USER_FEATURES,
  QWEN_OCR_COST_PER_PAGE_USD,
  FISH_ASR_COST_PER_REQUEST_USD,
  FISH_ASR_COST_PER_HOUR_USD,
  VOICE_DESIGN_COST_PER_REQUEST_USD,
  MAGNIFIC_UPSCALE_COST_USD,
  FLUX_PRO_COST_PER_IMAGE_USD,
  LEMONSLICE_AVATAR_REGISTRATION_COST_USD,
  NON_BILLABLE_FEATURES,
  LIVEKIT_ROOM_TOKEN_MODEL,
  FEATURE_BILLING_DIMENSION,
  TEXT_DIMENSION_FEATURES,
  ADMIN_DIMENSION_FEATURES,
} from './costCalculator';
import { readFileSync } from 'fs';
import { join } from 'path';

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

  it('gemini 系は gemini-2.5-flash に正規化する', () => {
    expect(normalizeModelKey('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(normalizeModelKey('gemini-2.0-pro')).toBe('gemini-2.5-flash');
    expect(normalizeModelKey('GEMINI-1.5-FLASH')).toBe('gemini-2.5-flash');
  });

  it('gpt-oss 系は 120b/20b を正しく分離する（"120b" は "20b" を部分文字列に含む罠）', () => {
    expect(normalizeModelKey('openai/gpt-oss-20b')).toBe('gpt-oss-20b');
    expect(normalizeModelKey('openai/gpt-oss-120b')).toBe('gpt-oss-120b');
    expect(normalizeModelKey('GPT-OSS-120B')).toBe('gpt-oss-120b');
  });

  it('gpt-oss は provider prefix / suffix 付き env override でも拾う', () => {
    expect(normalizeModelKey('groq/gpt-oss-20b')).toBe('gpt-oss-20b');
    expect(normalizeModelKey('gpt-oss-120b-128k')).toBe('gpt-oss-120b');
    expect(normalizeModelKey('gpt-oss')).toBe('gpt-oss-20b'); // 120 を含まなければ 20b 扱い
  });

  it('不明モデルは undefined を返す', () => {
    expect(normalizeModelKey('unknown-model-v99')).toBeUndefined();
    expect(normalizeModelKey('')).toBeUndefined();
  });

  // A2A-0i: LIVEKIT_ROOM_TOKEN_MODEL('livekit-room-token')は新しい列を増やさずに
  // 既存のmodel列を「識別子」として流用したもの(billingHealthCheck.tsのコメント参照)。
  // LLM価格表に一致してしまうと誤ってコストが計上される事故になるため、
  // どのLLM系パターン(8b/70b/gemini/embedding/perplexity/gpt-oss)にも
  // マッチせずundefinedになる(=コスト0扱い)ことを固定する。
  it('LIVEKIT_ROOM_TOKEN_MODELはLLM価格表のどのパターンにも一致せずundefinedになる(誤課金防止)', () => {
    expect(normalizeModelKey(LIVEKIT_ROOM_TOKEN_MODEL)).toBeUndefined();
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

  describe('gemini-2.5-flash', () => {
    it('1,000,000 input + 1,000,000 output tokens のコストが正確', () => {
      // input:  1_000_000 * 0.075 / 1_000_000 = $0.075 = 7.5 cents
      // output: 1_000_000 * 0.30  / 1_000_000 = $0.30  = 30 cents
      // total: 37.5 cents → Math.ceil = 38
      const result = calculateLLMCostCents({
        model: 'gemini-2.5-flash', inputTokens: 1_000_000, outputTokens: 1_000_000,
      });
      expect(result).toBe(38);
    });

    it('output は input より単価が高い', () => {
      const inputOnly  = calculateLLMCostCents({ model: 'gemini-2.5-flash', inputTokens: 1_000_000, outputTokens: 0 });
      const outputOnly = calculateLLMCostCents({ model: 'gemini-2.5-flash', inputTokens: 0, outputTokens: 1_000_000 });
      expect(outputOnly).toBeGreaterThan(inputOnly);
    });
  });

  describe('gpt-oss（planner LLM）', () => {
    it('gpt-oss-20b: 1M input + 1M output のコストが正確', () => {
      // input:  1_000_000 * 0.075 / 1_000_000 = $0.075 = 7.5 cents
      // output: 1_000_000 * 0.30  / 1_000_000 = $0.30  = 30 cents
      // total: 37.5 cents → Math.ceil = 38
      const result = calculateLLMCostCents({
        model: 'openai/gpt-oss-20b', inputTokens: 1_000_000, outputTokens: 1_000_000,
      });
      expect(result).toBe(38);
    });

    it('gpt-oss-120b: 1M input + 1M output のコストが正確（20b の2倍単価）', () => {
      // input:  1_000_000 * 0.15 / 1_000_000 = $0.15 = 15 cents
      // output: 1_000_000 * 0.60 / 1_000_000 = $0.60 = 60 cents
      // total: 75 cents → Math.ceil = 75
      const result = calculateLLMCostCents({
        model: 'openai/gpt-oss-120b', inputTokens: 1_000_000, outputTokens: 1_000_000,
      });
      expect(result).toBe(75);
    });

    it('120b は 20b より高コスト（誤正規化していれば破綻する）', () => {
      const cost20b  = calculateLLMCostCents({ model: 'openai/gpt-oss-20b',  inputTokens: 1_000_000, outputTokens: 1_000_000 });
      const cost120b = calculateLLMCostCents({ model: 'openai/gpt-oss-120b', inputTokens: 1_000_000, outputTokens: 1_000_000 });
      expect(cost120b).toBeGreaterThan(cost20b);
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

    // A2A-0i: livekitTokenRoutes.ts の実際の呼び出し形(model=LIVEKIT_ROOM_TOKEN_MODEL,
    // inputTokens=0, outputTokens=0)を再現し、0コストで確定することを固定する。
    it('LIVEKIT_ROOM_TOKEN_MODEL(inputTokens=0,outputTokens=0)は0を返す(billable=falseでも計算経路自体が安全)', () => {
      expect(
        calculateLLMCostCents({ model: LIVEKIT_ROOM_TOKEN_MODEL, inputTokens: 0, outputTokens: 0 }),
      ).toBe(0);
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

  it('extraLlmUsages: planner 分をモデル別実レートで本行に内包する（サーバーコストは二重計上しない）', () => {
    // chat 本体: 70B 0トークン → server cost のみ。+ planner: gpt-oss-120b 1M/1M。
    // planner LLM USD = 0.15 + 0.60 = 0.75。server = 0.0001。margin = 5（chat）。
    // total USD = (0.75 + 0.0001) * 5 = 3.7505 → cents = Math.ceil(375.05) = 376
    const withExtra = calculateBillingAmountCents({
      model:        'llama-3.1-70b-versatile',
      inputTokens:  0,
      outputTokens: 0,
      featureUsed:  'chat',
      extraLlmUsages: [
        { model: 'openai/gpt-oss-120b', inputTokens: 1_000_000, outputTokens: 1_000_000 },
      ],
    });
    expect(withExtra).toBe(376);

    // サーバーコストは1回のみ（extra を増やしても server 分は増えない）
    const base = calculateBillingAmountCents({
      model: 'llama-3.1-70b-versatile', inputTokens: 0, outputTokens: 0, featureUsed: 'chat',
    });
    // 差分 = planner LLM USD × margin（server 分は含まれない）
    expect(withExtra - base).toBe(375); // 0.75 * 5 * 100
  });

  it('extraLlmUsages: 複数モデル（20B parse失敗→120B）をそれぞれ実レートで合算する', () => {
    // cost_llm_cents 相当: 20B(1M/1M)=0.375 + 120B(1M/1M)=0.75 = 1.125 USD → ceil(112.5)=113
    const cents = calculateLLMCostCents({
      model: 'llama-3.1-70b-versatile',
      inputTokens: 0,
      outputTokens: 0,
      extraLlmUsages: [
        { model: 'openai/gpt-oss-20b',  inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { model: 'openai/gpt-oss-120b', inputTokens: 1_000_000, outputTokens: 1_000_000 },
      ],
    });
    expect(cents).toBe(113);
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

  // GID: totalUSDに加算される全フィールドは、負値を渡すと「請求額を減らす」
  // 攻撃・不具合の経路になりうる(例: ttsTextBytes=-1000000で他の正当な費用を
  // 相殺できてしまう)。inputTokens/outputTokensだけでなく全フィールドを一律で
  // ガードすることを固定する。
  describe('負の値は全フィールドで例外を投げる(請求額を減らす攻撃・不具合の防止)', () => {
    const base = { model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0 } as const;

    it.each([
      ['ttsTextBytes', -1],
      ['avatarCredits', -1],
      ['imageCount', -1],
      ['saiAgentSteps', -1],
      ['ocrPages', -1],
      ['asrRequestCount', -1],
      ['asrAudioSeconds', -1],
      ['magnificUpscaleCount', -1],
      ['fluxImageCount', -1],
      ['lemonsliceRegistrationCount', -1],
      ['voiceDesignRequestCount', -1],
    ] as const)('%s が負の場合に例外を投げる', (field, value) => {
      expect(() =>
        calculateBillingAmountCents({ ...base, [field]: value })
      ).toThrow(`Invalid ${field}: ${value}`);
    });

    it('複数フィールドが同時に負でも(最初に検出した1件で)例外を投げる', () => {
      expect(() =>
        calculateBillingAmountCents({ ...base, ttsTextBytes: -100, avatarCredits: -5 })
      ).toThrow();
    });

    it('巨大な負値(Number.MIN_SAFE_INTEGER)でも例外を投げる(オーバーフローで正の値に化けない)', () => {
      expect(() =>
        calculateBillingAmountCents({ ...base, asrAudioSeconds: Number.MIN_SAFE_INTEGER })
      ).toThrow();
    });

    it('0はどのフィールドでも例外を投げない(負値ガードの境界は0を含む)', () => {
      const result = calculateBillingAmountCents({
        ...base,
        ttsTextBytes: 0, avatarCredits: 0, imageCount: 0, saiAgentSteps: 0, ocrPages: 0,
        asrRequestCount: 0, asrAudioSeconds: 0, magnificUpscaleCount: 0, fluxImageCount: 0,
        lemonsliceRegistrationCount: 0, voiceDesignRequestCount: 0,
      });
      expect(result).toBeGreaterThanOrEqual(0);
    });
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
// GID 1217083837550852: fishTtsCostPerByteUsd / ttsModel 連動
// ---------------------------------------------------------------------------
describe('fishTtsCostPerByteUsd', () => {
  it('s2.1-pro-free は無料(0)', () => {
    expect(fishTtsCostPerByteUsd('s2.1-pro-free')).toBe(0);
  });

  it('s2.1-pro は有料単価($15/M byte)', () => {
    expect(fishTtsCostPerByteUsd('s2.1-pro')).toBe(FISH_AUDIO_COST_PER_BYTE_USD);
  });

  it('未知のモデル名は有料単価にフォールバックする', () => {
    expect(fishTtsCostPerByteUsd('unknown-model')).toBe(FISH_AUDIO_COST_PER_BYTE_USD);
  });

  it('モデル省略時は有料単価にフォールバックする(既存呼び出し元との後方互換)', () => {
    expect(fishTtsCostPerByteUsd(undefined)).toBe(FISH_AUDIO_COST_PER_BYTE_USD);
  });
});

describe('calculateBillingAmountCents: ttsModel', () => {
  it('ttsModel=s2.1-pro-free のとき ttsTextBytes があってもTTS分は0円', () => {
    const withFreeModel = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      ttsTextBytes: 1_000_000, ttsModel: 's2.1-pro-free',
    });
    const withoutTts = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
    });
    expect(withFreeModel).toBe(withoutTts);
  });

  it('ttsModel未指定時は既存どおり有料単価で計上される（後方互換）', () => {
    const withoutModel = calculateBillingAmountCents({
      model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0,
      ttsTextBytes: 1_000_000,
    });
    expect(withoutModel).toBeGreaterThanOrEqual(1500);
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
// Phase3 (Sai接続ブリッジ): saiAgentSteps コスト組み込み
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents: saiAgentSteps', () => {
  it('saiAgentSteps=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({
      model: 'agent-s', inputTokens: 0, outputTokens: 0,
    });
    const withZero = calculateBillingAmountCents({
      model: 'agent-s', inputTokens: 0, outputTokens: 0, saiAgentSteps: 0,
    });
    expect(withZero).toBe(base);
  });

  it('saiAgentSteps=3: SAI_AGENT_COST_PER_STEP_USD(デフォルト$0.05)の3ステップ分が加算される', () => {
    // serverCost=0.0001, saiCost=3*0.05=0.15 → total=0.1501 USD → Math.ceil(15.01) = 16 cents
    const result = calculateBillingAmountCents({
      model: 'agent-s', inputTokens: 0, outputTokens: 0,
      featureUsed: 'sai_agent', saiAgentSteps: 3,
    });
    expect(result).toBe(16);
  });

  it('featureUsed=sai_agentはEND_USER_FEATURESに含まれないため原価のみ(×1)', () => {
    const withMargin = calculateBillingAmountCents({
      model: 'agent-s', inputTokens: 0, outputTokens: 0,
      featureUsed: 'sai_agent', saiAgentSteps: 1, marginOverride: 5,
    });
    const atCost = calculateBillingAmountCents({
      model: 'agent-s', inputTokens: 0, outputTokens: 0,
      featureUsed: 'sai_agent', saiAgentSteps: 1,
    });
    // marginOverride を明示しない限り管理機能扱いで×1、明示すればそちらが優先される
    expect(atCost).toBeLessThan(withMargin);
  });

  it('整数を返す', () => {
    const result = calculateBillingAmountCents({
      model: 'agent-s', inputTokens: 0, outputTokens: 0,
      saiAgentSteps: 7,
    });
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GID 1216944049264977: これまでtrackUsage対象外だった外部API課金経路
// (Qwen OCR / Fish Audio ASR / Magnific / Flux 2 Pro / LemonSliceアバター登録)
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents: ocrPages（Qwen OCR）', () => {
  it('ocrPages=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({ model: 'qwen-vl-max-latest', inputTokens: 0, outputTokens: 0 });
    const withZero = calculateBillingAmountCents({
      model: 'qwen-vl-max-latest', inputTokens: 0, outputTokens: 0, ocrPages: 0,
    });
    expect(withZero).toBe(base);
  });

  it('ocrPages=1: QWEN_OCR_COST_PER_PAGE_USD(デフォルト$0.01)の1ページ分が加算される', () => {
    // serverCost=0.0001, ocrCost=0.01 → total=0.0101 USD → Math.ceil(1.01) = 2 cents
    const result = calculateBillingAmountCents({
      model: 'qwen-vl-max-latest', inputTokens: 0, outputTokens: 0,
      featureUsed: 'book_analysis', ocrPages: 1,
    });
    expect(result).toBe(2);
  });

  it('ocrPages=3（3ページ取り込み）: 3ページ分のコストが加算される', () => {
    // serverCost=0.0001, ocrCost=3*0.01=0.03 → total=0.0301 USD → Math.ceil(3.01) = 4 cents
    const result = calculateBillingAmountCents({
      model: 'qwen-vl-max-latest', inputTokens: 0, outputTokens: 0,
      featureUsed: 'book_analysis', ocrPages: 3,
    });
    expect(result).toBe(4);
  });

  it('埋め込み(extraLlmUsages: openai-embedding)を合算しても整数を返す', () => {
    // 3ページ×3チャンク=9チャンク、1チャンックあたり50トークンと仮定
    const result = calculateBillingAmountCents({
      model: 'qwen-vl-max-latest', inputTokens: 0, outputTokens: 0,
      featureUsed: 'book_analysis', ocrPages: 3,
      extraLlmUsages: [{ model: 'openai-embedding', inputTokens: 450, outputTokens: 0 }],
    });
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(4); // 埋め込み分だけ ocrPages=3 単体より高いか同じ
  });

  it('book_analysisはEND_USER_FEATURESに含まれないため原価のみ(×1)', () => {
    const atCost = calculateBillingAmountCents({
      model: 'qwen-vl-max-latest', inputTokens: 0, outputTokens: 0,
      featureUsed: 'book_analysis', ocrPages: 1,
    });
    const withMargin = calculateBillingAmountCents({
      model: 'qwen-vl-max-latest', inputTokens: 0, outputTokens: 0,
      featureUsed: 'book_analysis', ocrPages: 1, marginOverride: 5,
    });
    expect(atCost).toBeLessThan(withMargin);
  });
});

describe('calculateBillingAmountCents: asrRequestCount（Fish Audio ASR）', () => {
  it('asrRequestCount=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({ model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0 });
    const withZero = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0, asrRequestCount: 0,
    });
    expect(withZero).toBe(base);
  });

  it('asrRequestCount=1: FISH_ASR_COST_PER_REQUEST_USD(デフォルト$0.01)の1件分が加算される（voiceはEND_USER_FEATURESなのでMARGIN_MULTIPLIER×5適用）', () => {
    // serverCost=0.0001, asrCost=0.01 → total=0.0101 USD × margin5 = 0.0505 → Math.ceil(5.05) = 6 cents
    const result = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrRequestCount: 1,
    });
    expect(result).toBe(6);
  });

  it('asrRequestCount=2: 2件分のコストが加算される', () => {
    // serverCost=0.0001, asrCost=2*0.01=0.02 → total=0.0201 USD × margin5 = 0.1005 → Math.ceil(10.05) = 11 cents
    const result = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrRequestCount: 2,
    });
    expect(result).toBe(11);
  });

  it('featureUsed=voiceはEND_USER_FEATURESに含まれるためMARGIN_MULTIPLIERが適用される', () => {
    expect(END_USER_FEATURES.has('voice')).toBe(true);
    const withDefaultMargin = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrRequestCount: 1,
    });
    const atCost = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrRequestCount: 1, marginOverride: 1,
    });
    expect(withDefaultMargin).toBeGreaterThan(atCost);
  });
});

// ---------------------------------------------------------------------------
// GID 1217083837550916: calculateBillingAmountCents: asrAudioSeconds（Fish Audio ASR秒数課金）
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents: asrAudioSeconds（Fish Audio ASR秒数課金）', () => {
  it('FISH_ASR_COST_PER_HOUR_USD は公式単価$0.36/audio hour', () => {
    expect(FISH_ASR_COST_PER_HOUR_USD).toBe(0.36);
  });

  it('asrAudioSeconds=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({ model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0 });
    const withZero = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0, asrAudioSeconds: 0,
    });
    expect(withZero).toBe(base);
  });

  it('asrAudioSeconds=3600(1時間): $0.36の1件分が加算される（voiceはMARGIN_MULTIPLIER×5適用）', () => {
    // serverCost=0.0001, asrCost=ceil(3600)/3600*0.36=0.36 → total=0.3601 USD × margin5 = 1.8005 → Math.ceil(180.05) = 181 cents
    const result = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrAudioSeconds: 3600,
    });
    expect(result).toBe(181);
  });

  it('秒未満は切り上げられる（0.4秒は1秒として課金される）', () => {
    const fractional = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrAudioSeconds: 0.4,
    });
    const oneSecond = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrAudioSeconds: 1,
    });
    expect(fractional).toBe(oneSecond);
  });

  it('asrAudioSeconds指定時はasrRequestCountが同時にあっても二重計上されない（asrAudioSecondsを優先）', () => {
    const secondsOnly = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrAudioSeconds: 3600,
    });
    const secondsAndRequestCount = calculateBillingAmountCents({
      model: 'fish-audio-asr', inputTokens: 0, outputTokens: 0,
      featureUsed: 'voice', asrAudioSeconds: 3600, asrRequestCount: 100,
    });
    expect(secondsAndRequestCount).toBe(secondsOnly);
  });
});

// ---------------------------------------------------------------------------
// GID 1217084040137242: calculateBillingAmountCents: voiceDesignRequestCount（Fish Audio Voice Design）
// ---------------------------------------------------------------------------
describe('calculateBillingAmountCents: voiceDesignRequestCount（Fish Audio Voice Design）', () => {
  it('VOICE_DESIGN_COST_PER_REQUEST_USD は公式単価$0.01/成功リクエスト', () => {
    expect(VOICE_DESIGN_COST_PER_REQUEST_USD).toBe(0.01);
  });

  it('voiceDesignRequestCount=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({ model: 'fish-audio-voice-design-1', inputTokens: 0, outputTokens: 0 });
    const withZero = calculateBillingAmountCents({
      model: 'fish-audio-voice-design-1', inputTokens: 0, outputTokens: 0, voiceDesignRequestCount: 0,
    });
    expect(withZero).toBe(base);
  });

  it('voiceDesignRequestCount=1: avatar_config_voiceはEND_USER_FEATURES外なのでmargin=1（原価のみ）', () => {
    // serverCost=0.0001, voiceDesignCost=0.01 → total=0.0101 USD × margin1 = 0.0101 → Math.ceil(1.01) = 2 cents
    const result = calculateBillingAmountCents({
      model: 'fish-audio-voice-design-1', inputTokens: 0, outputTokens: 0,
      featureUsed: 'avatar_config_voice', voiceDesignRequestCount: 1,
    });
    expect(result).toBe(2);
  });

  it('voiceDesignRequestCount=2: 2件分のコストが加算される', () => {
    // serverCost=0.0001, voiceDesignCost=2*0.01=0.02 → total=0.0201 USD × margin1 = 0.0201 → Math.ceil(2.01) = 3 cents
    const result = calculateBillingAmountCents({
      model: 'fish-audio-voice-design-1', inputTokens: 0, outputTokens: 0,
      featureUsed: 'avatar_config_voice', voiceDesignRequestCount: 2,
    });
    expect(result).toBe(3);
  });
});

describe('calculateBillingAmountCents: magnificUpscaleCount / fluxImageCount（プレミアムアバター生成）', () => {
  it('magnificUpscaleCount=0・fluxImageCount=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({ model: 'flux-pro-v1.1', inputTokens: 0, outputTokens: 0 });
    const withZero = calculateBillingAmountCents({
      model: 'flux-pro-v1.1', inputTokens: 0, outputTokens: 0, magnificUpscaleCount: 0, fluxImageCount: 0,
    });
    expect(withZero).toBe(base);
  });

  it('fluxImageCount=1: FLUX_PRO_COST_PER_IMAGE_USD(デフォルト$0.055)の1枚分が加算される', () => {
    // serverCost=0.0001, fluxCost=0.055 → total=0.0551 USD → Math.ceil(5.51) = 6 cents
    const result = calculateBillingAmountCents({
      model: 'flux-pro-v1.1', inputTokens: 0, outputTokens: 0,
      featureUsed: 'premium_avatar_generation', fluxImageCount: 1,
    });
    expect(result).toBe(6);
  });

  it('magnificUpscaleCount=1: MAGNIFIC_UPSCALE_COST_USD(デフォルト$0.08)の1回分が加算される', () => {
    // serverCost=0.0001, magnificCost=0.08 → total=0.0801 USD → Math.ceil(8.01) = 9 cents
    const result = calculateBillingAmountCents({
      model: 'flux-pro-v1.1', inputTokens: 0, outputTokens: 0,
      featureUsed: 'premium_avatar_generation', magnificUpscaleCount: 1,
    });
    expect(result).toBe(9);
  });

  it('flux+magnific併用: 両方のコストが合算される', () => {
    // serverCost=0.0001, fluxCost=0.055, magnificCost=0.08 → total=0.1351 USD → Math.ceil(13.51) = 14 cents
    const result = calculateBillingAmountCents({
      model: 'flux-pro-v1.1', inputTokens: 0, outputTokens: 0,
      featureUsed: 'premium_avatar_generation', fluxImageCount: 1, magnificUpscaleCount: 1,
    });
    expect(result).toBe(14);
  });
});

describe('calculateBillingAmountCents: lemonsliceRegistrationCount（LemonSliceアバター登録）', () => {
  it('lemonsliceRegistrationCount=0 は既存と同結果', () => {
    const base = calculateBillingAmountCents({ model: 'lemon-slice-register', inputTokens: 0, outputTokens: 0 });
    const withZero = calculateBillingAmountCents({
      model: 'lemon-slice-register', inputTokens: 0, outputTokens: 0, lemonsliceRegistrationCount: 0,
    });
    expect(withZero).toBe(base);
  });

  it('lemonsliceRegistrationCount=1: デフォルト単価$0未確定のためserverCostのみ計上される', () => {
    // serverCost=0.0001, registrationCost=0 → total=0.0001 USD → Math.ceil(0.01) = 1 cent
    const result = calculateBillingAmountCents({
      model: 'lemon-slice-register', inputTokens: 0, outputTokens: 0,
      featureUsed: 'avatar_config_image', lemonsliceRegistrationCount: 1,
    });
    expect(result).toBe(1);
  });

  it('整数を返す', () => {
    const result = calculateBillingAmountCents({
      model: 'lemon-slice-register', inputTokens: 0, outputTokens: 0,
      lemonsliceRegistrationCount: 2,
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

  // [A2A-1a]: agent_search は 'chat' から分離した外部エージェント連携API
  // (対外向けの従量課金APIであり運用ツールではない)。ここから外れると
  // MARGIN_MULTIPLIER が適用されなくなり、Growth/Standard向けの粗利が消える。
  it('agent_searchが含まれる(chat/avatar/voiceと同格の対外課金機能)', () => {
    expect(END_USER_FEATURES.has('agent_search')).toBe(true);
  });

  it('featureUsed=agent_searchはMARGIN_MULTIPLIERが適用される(管理機能の原価のみ×1にならない)', () => {
    // トークン数は小さすぎるとceil()の丸めで margin=1/5 の差が1セント未満に埋もれる
    // (例: 1000トークンだと両方とも1セントに丸まり差が消える)ため、差が明確に
    // 出る規模にする。
    const withDefaultMargin = calculateBillingAmountCents({
      model: 'gpt-oss-120b', inputTokens: 100_000, outputTokens: 100_000,
      featureUsed: 'agent_search',
    });
    // marginOverride:1 で明示的に原価のみ(×1)にした場合と比較する(sai_agent/
    // book_analysisの既存テストと同じ比較の型)。agent_search が END_USER_FEATURES
    // から漏れて管理機能扱い(既定×1)になっていたら、この2つは一致してしまう。
    const atCostOnly = calculateBillingAmountCents({
      model: 'gpt-oss-120b', inputTokens: 100_000, outputTokens: 100_000,
      featureUsed: 'agent_search', marginOverride: 1,
    });
    expect(withDefaultMargin).toBeGreaterThan(atCostOnly);
  });
});

// ---------------------------------------------------------------------------
// GID 1216944003337186: NON_BILLABLE_FEATURES 定数チェック
// ---------------------------------------------------------------------------
describe('NON_BILLABLE_FEATURES', () => {
  it('管理系LLM機能(tuning/ai-assist/engagement-suggest/option-estimator)が含まれる', () => {
    expect(NON_BILLABLE_FEATURES.has('admin_tuning')).toBe(true);
    expect(NON_BILLABLE_FEATURES.has('admin_ai_assist')).toBe(true);
    expect(NON_BILLABLE_FEATURES.has('admin_engagement_suggest')).toBe(true);
    expect(NON_BILLABLE_FEATURES.has('admin_option_estimator')).toBe(true);
  });

  it('sai_agentが含まれる（chargeOneOffJpyで既に請求済みのため二重計上防止）', () => {
    expect(NON_BILLABLE_FEATURES.has('sai_agent')).toBe(true);
  });

  it('エンドユーザー向け機能・課金対象の管理機能は含まれない', () => {
    expect(NON_BILLABLE_FEATURES.has('chat')).toBe(false);
    expect(NON_BILLABLE_FEATURES.has('avatar')).toBe(false);
    expect(NON_BILLABLE_FEATURES.has('voice')).toBe(false);
    expect(NON_BILLABLE_FEATURES.has('admin_agent')).toBe(false);
    expect(NON_BILLABLE_FEATURES.has('avatar_config_image')).toBe(false);
    expect(NON_BILLABLE_FEATURES.has('premium_avatar_generation')).toBe(false);
  });

  // S4(GID 1218086647623729系): FEATURE_BILLING_DIMENSION の 'none' エントリから
  // 導出するようになった後も、従来と同じ5要素のままであることを固定する。
  it('FEATURE_BILLING_DIMENSIONから導出した後も従来と同じ5要素のまま', () => {
    expect(NON_BILLABLE_FEATURES.size).toBe(5);
    expect([...NON_BILLABLE_FEATURES].sort()).toEqual([
      'admin_ai_assist',
      'admin_engagement_suggest',
      'admin_option_estimator',
      'admin_tuning',
      'sai_agent',
    ]);
  });
});

// ---------------------------------------------------------------------------
// S4: FEATURE_BILLING_DIMENSION 定数チェック(管理AI原価の課金・可視化)
// ---------------------------------------------------------------------------
describe('FEATURE_BILLING_DIMENSION', () => {
  it('admin_agent(管理AIへの相談)は"admin"次元', () => {
    expect(FEATURE_BILLING_DIMENSION.admin_agent).toBe('admin');
  });

  it('chat / agent_search は"text"次元', () => {
    expect(FEATURE_BILLING_DIMENSION.chat).toBe('text');
    expect(FEATURE_BILLING_DIMENSION.agent_search).toBe('text');
  });

  it('avatar / anam_session は"avatar"次元', () => {
    expect(FEATURE_BILLING_DIMENSION.avatar).toBe('avatar');
    expect(FEATURE_BILLING_DIMENSION.anam_session).toBe('avatar');
  });

  it('NON_BILLABLE_FEATURESの5機能は"none"次元', () => {
    for (const feature of NON_BILLABLE_FEATURES) {
      expect(FEATURE_BILLING_DIMENSION[feature as keyof typeof FEATURE_BILLING_DIMENSION]).toBe('none');
    }
  });

  it('TEXT_DIMENSION_FEATURES / ADMIN_DIMENSION_FEATURES はFEATURE_BILLING_DIMENSIONから導出される', () => {
    expect([...TEXT_DIMENSION_FEATURES].sort()).toEqual(['agent_search', 'chat']);
    expect(ADMIN_DIMENSION_FEATURES).toEqual(['admin_agent']);
  });

  // ---------------------------------------------------------------------------
  // スキーマ↔コード整合: usage_logs.feature_used の CHECK 制約と1対1であること。
  //
  // ★なぜこのテストが要るか★
  // FEATURE_BILLING_DIMENSION に新しい featureUsed を足しても、TypeScript は
  // それだけで動く(FeatureUsed 型はこの map から導出されるため)。しかし DB 側の
  // usage_logs_feature_used_check 制約に対応する値を追加する migration
  // (人間承認・手動適用)を忘れると、trackUsage({featureUsed: '新しい値'}) の
  // INSERT が CHECK 制約違反(23514)で失敗する。usageTracker.ts の _insertUsageLog は
  // 42703(列欠落)以外の例外を catch して logger.error に落とすだけの
  // fire-and-forget 設計なので、この失敗は API レスポンスにも画面にも一切出ず、
  // 該当機能の利用記録・請求だけが本番で無言のまま消え続ける
  // (CLAUDE.md 禁止42「マージ済み・デプロイ済みは本番で動いているを意味しない」と
  // 同じ形の事故。かつ禁止50「監視が0件で沈黙」も併発する — 記録が無いので
  // 異常検知の対象にすら乗らない)。
  //
  // 制約は DROP+ADD で置き換わる累積 migration なので、最後に更新された
  // ファイル(2026-09時点は migration_agent_search_feature.sql)が現在の
  // 完全なリストを持つ。次に featureUsed を追加する人は、この migration ファイルの
  // 隣に新しい migration_*.sql を足して制約を置き換えること
  // (このテストの読み先を書き換えるのではなく、新しいファイルを追加する形)。
  it('FEATURE_BILLING_DIMENSION のキーは usage_logs_feature_used_check 制約(migration_agent_search_feature.sql)の値と1対1', () => {
    const migrationSql = readFileSync(
      join(__dirname, 'migration_agent_search_feature.sql'),
      'utf8',
    );
    const match = migrationSql.match(/CHECK \(feature_used IN \(([\s\S]*?)\)\)/);
    expect(match).not.toBeNull();
    const constraintValues = [...match![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);

    const mapKeys = Object.keys(FEATURE_BILLING_DIMENSION);

    // 制約にあるのに map に無い(=課金次元を宣言し忘れている。CLAUDE.md禁止6と同種)
    const missingInMap = constraintValues.filter((v) => !mapKeys.includes(v));
    // map にあるのに制約に無い(=migrationを書き忘れている。INSERTが23514で無言消失する)
    const missingInConstraint = mapKeys.filter((k) => !constraintValues.includes(k));

    expect(missingInMap).toEqual([]);
    expect(missingInConstraint).toEqual([]);
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

  // GID 1216944049264977: いずれも公式単価未確定の暫定値（要検証）。0以上であることのみ保証する。
  it('QWEN_OCR_COST_PER_PAGE_USD / FISH_ASR_COST_PER_REQUEST_USD / MAGNIFIC_UPSCALE_COST_USD / FLUX_PRO_COST_PER_IMAGE_USD / LEMONSLICE_AVATAR_REGISTRATION_COST_USD は非負の値', () => {
    expect(QWEN_OCR_COST_PER_PAGE_USD).toBeGreaterThanOrEqual(0);
    expect(FISH_ASR_COST_PER_REQUEST_USD).toBeGreaterThanOrEqual(0);
    expect(MAGNIFIC_UPSCALE_COST_USD).toBeGreaterThanOrEqual(0);
    expect(FLUX_PRO_COST_PER_IMAGE_USD).toBeGreaterThanOrEqual(0);
    expect(LEMONSLICE_AVATAR_REGISTRATION_COST_USD).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// calculateBaseCostCents（usage_logs.cost_base_cents の記録元）
//
// この関数が守るべき性質は「マージンを一切適用しない」こと。
// ここが崩れると粗利（売上 − 原価）が MARGIN_MULTIPLIER 倍ずれる。
// ---------------------------------------------------------------------------
describe('calculateBaseCostCents', () => {
  const base = { model: 'llama-3.1-8b-instant', inputTokens: 100_000, outputTokens: 50_000 };

  it('★マージンを適用しない★ — end-user 機能でも原価そのものを返す', () => {
    const withMargin = calculateBillingAmountCents({ ...base, featureUsed: 'chat' });
    const withoutMargin = calculateBaseCostCents({ ...base, featureUsed: 'chat' });

    expect(withoutMargin).toBeLessThan(withMargin);
    // Math.ceil が base と total で別々に効くため厳密な整数倍にはならない。
    // ずれは高々 margin セント（切り上げ1回ぶん × margin）。
    expect(Math.abs(withoutMargin * MARGIN_MULTIPLIER - withMargin))
      .toBeLessThanOrEqual(MARGIN_MULTIPLIER);
  });

  it('管理系機能(margin=1)では cost_total_cents と一致する', () => {
    const adminFeature = 'admin_tuning';
    expect(END_USER_FEATURES.has(adminFeature)).toBe(false);
    expect(calculateBaseCostCents({ ...base, featureUsed: adminFeature }))
      .toBe(calculateBillingAmountCents({ ...base, featureUsed: adminFeature }));
  });

  it('marginOverride は原価に影響しない（倍率にしか効かない列だから）', () => {
    const withOverride = calculateBaseCostCents({ ...base, featureUsed: 'chat', marginOverride: 1 });
    const withoutOverride = calculateBaseCostCents({ ...base, featureUsed: 'chat' });
    expect(withOverride).toBe(withoutOverride);
  });

  it('LLM 以外の原価も含む（cost_llm_cents との違い）', () => {
    const llmOnly = calculateLLMCostCents(base);
    const withTts = calculateBaseCostCents({ ...base, featureUsed: 'voice', ttsTextBytes: 100_000 });
    // cost_llm_cents は LLM 分のみ。cost_base_cents は TTS/server cost も含むので必ず大きい。
    expect(withTts).toBeGreaterThan(llmOnly);
  });

  it('負値ガードは calculateBillingAmountCents と同じく効く', () => {
    expect(() => calculateBaseCostCents({ ...base, inputTokens: -1 })).toThrow();
    expect(() => calculateBaseCostCents({ ...base, ttsTextBytes: -1 })).toThrow();
  });

  it('利用ゼロでも server cost があるため 0 にはならない', () => {
    const zero = calculateBaseCostCents({ model: 'llama-3.1-8b-instant', inputTokens: 0, outputTokens: 0 });
    expect(zero).toBeGreaterThan(0);
    expect(zero).toBe(Math.ceil(SERVER_COST_PER_REQUEST_USD * 100));
  });
});
