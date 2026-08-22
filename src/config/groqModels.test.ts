// src/config/groqModels.test.ts
// Groq モデルカタログ + EOL 検知ヘルパーのユニットテスト

import {
  ACTIVE_GROQ_MODELS,
  ACTIVE_GROQ_MODEL_IDS,
  KNOWN_DEPRECATED_GROQ_MODELS,
  GROQ_FALLBACK_CHAIN,
  GPT_OSS_120B,
  GPT_OSS_20B,
  GROQ_COMPOUND,
  GROQ_COMPOUND_MINI,
  isDeprecatedGroqModel,
  assertActiveGroqModel,
  getFallbackGroqModel,
} from './groqModels';

describe('groqModels catalog', () => {
  it('アクティブ定数は実モデル ID と一致する（集約後も値が変わらない回帰ガード）', () => {
    expect(GPT_OSS_120B).toBe('openai/gpt-oss-120b');
    expect(GPT_OSS_20B).toBe('openai/gpt-oss-20b');
    expect(GROQ_COMPOUND).toBe('groq/compound');
    expect(GROQ_COMPOUND_MINI).toBe('groq/compound-mini');
  });

  it('アクティブモデルは1件も EOL リストに含まれない', () => {
    for (const id of ACTIVE_GROQ_MODEL_IDS) {
      expect(isDeprecatedGroqModel(id)).toBe(false);
    }
  });

  it('ACTIVE と KNOWN_DEPRECATED は交差しない（同一 ID が両方に載る矛盾の防止）', () => {
    const active = new Set(ACTIVE_GROQ_MODEL_IDS);
    const overlap = KNOWN_DEPRECATED_GROQ_MODELS.filter((id) => active.has(id));
    expect(overlap).toEqual([]);
  });

  it('ACTIVE_GROQ_MODELS の status は全て active', () => {
    expect(ACTIVE_GROQ_MODELS.every((m) => m.status === 'active')).toBe(true);
  });

  it('ID に重複がない', () => {
    expect(new Set(ACTIVE_GROQ_MODEL_IDS).size).toBe(ACTIVE_GROQ_MODEL_IDS.length);
  });

  it('2026-08-23 に配信停止された 2 モデルは EOL リストに載っている', () => {
    // 本番でアバターチャットを停止させた 2 件。カタログから消しただけでは
    // 検知層(SCRIPTS/check-groq-models.sh)が再混入を防げないため、明示的に固定する。
    expect(isDeprecatedGroqModel('llama-3.3-70b-versatile')).toBe(true);
    expect(isDeprecatedGroqModel('llama-3.1-8b-instant')).toBe(true);
  });
});

describe('GROQ_FALLBACK_CHAIN', () => {
  it('【最重要】全ての退避先がアクティブモデルである', () => {
    // 2026-08-23 の本番障害の直接原因: 退避先が既に配信停止された llama 系を指しており、
    // 「生きているモデルから退避すると必ず死んだモデルに着地する」構造になっていた。
    // 404 時の救済機構が、逆に全経路を確実な失敗へ導いていた。
    const active = new Set(ACTIVE_GROQ_MODEL_IDS);
    for (const [from, to] of Object.entries(GROQ_FALLBACK_CHAIN)) {
      expect(active.has(to)).toBe(true);
      // 退避元もカタログに存在しないと、そのエントリは到達不能な死んだ設定になる
      expect(active.has(from)).toBe(true);
    }
  });

  it('退避先が EOL モデルを指していない', () => {
    for (const to of Object.values(GROQ_FALLBACK_CHAIN)) {
      expect(isDeprecatedGroqModel(to)).toBe(false);
    }
  });

  it('チェーンを辿っても循環せず必ず終端に到達する', () => {
    for (const start of ACTIVE_GROQ_MODEL_IDS) {
      const visited = new Set<string>([start]);
      let current: string | null = start;
      while (current !== null) {
        const next: string | null = getFallbackGroqModel(current);
        if (next === null) break;
        expect(visited.has(next)).toBe(false); // 循環していないこと
        visited.add(next);
        current = next;
      }
      // 終端に到達している（無限ループで抜けていない）
      expect(current === null || getFallbackGroqModel(current) === null).toBe(true);
    }
  });

  it('自分自身へフォールバックするエントリが無い', () => {
    for (const [from, to] of Object.entries(GROQ_FALLBACK_CHAIN)) {
      expect(from).not.toBe(to);
    }
  });

  it('主力 120B は 20B へ退避し、20B が終端', () => {
    expect(getFallbackGroqModel(GPT_OSS_120B)).toBe(GPT_OSS_20B);
    expect(getFallbackGroqModel(GPT_OSS_20B)).toBeNull();
  });

  it('compound 系は汎用モデルへ抜けられる', () => {
    expect(getFallbackGroqModel(GROQ_COMPOUND)).toBe(GROQ_COMPOUND_MINI);
    expect(getFallbackGroqModel(GROQ_COMPOUND_MINI)).toBe(GPT_OSS_120B);
  });
});

describe('isDeprecatedGroqModel', () => {
  it('decommissioned モデルを true で検出する', () => {
    expect(isDeprecatedGroqModel('llama-3.1-70b-versatile')).toBe(true);
    expect(isDeprecatedGroqModel('mixtral-8x7b-32768')).toBe(true);
  });

  it('アクティブ / 未知のモデルは false', () => {
    expect(isDeprecatedGroqModel(GPT_OSS_120B)).toBe(false);
    expect(isDeprecatedGroqModel('some-future-model')).toBe(false);
  });

  it('EOL リストは空でない（検知層が機能する前提）', () => {
    expect(KNOWN_DEPRECATED_GROQ_MODELS.length).toBeGreaterThan(0);
  });
});

describe('assertActiveGroqModel', () => {
  it('アクティブモデルは通過する', () => {
    expect(() => assertActiveGroqModel(GPT_OSS_120B)).not.toThrow();
    expect(() => assertActiveGroqModel(GPT_OSS_20B)).not.toThrow();
  });

  it('EOL モデルは例外を投げる', () => {
    expect(() => assertActiveGroqModel('llama-3.1-70b-versatile')).toThrow(/decommissioned/);
    expect(() => assertActiveGroqModel('llama-3.3-70b-versatile')).toThrow(/decommissioned/);
  });
});
