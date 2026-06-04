// src/config/groqModels.test.ts
// Groq モデルカタログ + EOL 検知ヘルパーのユニットテスト

import {
  ACTIVE_GROQ_MODELS,
  ACTIVE_GROQ_MODEL_IDS,
  KNOWN_DEPRECATED_GROQ_MODELS,
  GROQ_INSTANT_8B,
  GROQ_VERSATILE_70B,
  isDeprecatedGroqModel,
  assertActiveGroqModel,
} from './groqModels';

describe('groqModels catalog', () => {
  it('アクティブ定数は実モデル ID と一致する（集約後も値が変わらない回帰ガード）', () => {
    expect(GROQ_INSTANT_8B).toBe('llama-3.1-8b-instant');
    expect(GROQ_VERSATILE_70B).toBe('llama-3.3-70b-versatile');
  });

  it('アクティブモデルは1件も EOL リストに含まれない', () => {
    for (const id of ACTIVE_GROQ_MODEL_IDS) {
      expect(isDeprecatedGroqModel(id)).toBe(false);
    }
  });

  it('ACTIVE_GROQ_MODELS の status は全て active', () => {
    expect(ACTIVE_GROQ_MODELS.every((m) => m.status === 'active')).toBe(true);
  });

  it('ID に重複がない', () => {
    expect(new Set(ACTIVE_GROQ_MODEL_IDS).size).toBe(ACTIVE_GROQ_MODEL_IDS.length);
  });
});

describe('isDeprecatedGroqModel', () => {
  it('decommissioned モデルを true で検出する', () => {
    expect(isDeprecatedGroqModel('llama-3.1-70b-versatile')).toBe(true);
    expect(isDeprecatedGroqModel('mixtral-8x7b-32768')).toBe(true);
  });

  it('アクティブ / 未知のモデルは false', () => {
    expect(isDeprecatedGroqModel(GROQ_VERSATILE_70B)).toBe(false);
    expect(isDeprecatedGroqModel('some-future-model')).toBe(false);
  });

  it('EOL リストは空でない（検知層が機能する前提）', () => {
    expect(KNOWN_DEPRECATED_GROQ_MODELS.length).toBeGreaterThan(0);
  });
});

describe('assertActiveGroqModel', () => {
  it('アクティブモデルは通過する', () => {
    expect(() => assertActiveGroqModel(GROQ_INSTANT_8B)).not.toThrow();
  });

  it('EOL モデルは例外を投げる', () => {
    expect(() => assertActiveGroqModel('llama-3.1-70b-versatile')).toThrow(/decommissioned/);
  });
});
