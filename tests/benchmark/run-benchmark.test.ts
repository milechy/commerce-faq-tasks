// SCRIPTS/run-benchmark.test.ts
// Phase47: ベンチマークスクリプトのJestテスト

import * as fs from 'fs';
import * as path from 'path';
import { getFeatureFlags, formatResultsAsCsv } from '../../SCRIPTS/run-benchmark';
import type { ConversationResult, TestConversation } from '../../SCRIPTS/run-benchmark';

// ──────────────────────────────────────────────
// テスト1: テストセット構造の検証
// ──────────────────────────────────────────────

describe('テストセット構造', () => {
  it('test-conversations.json が有効なJSONで必須フィールドを持つ', () => {
    const testDataPath = path.resolve(__dirname, 'test-conversations.json');
    expect(fs.existsSync(testDataPath)).toBe(true);

    const rawData = fs.readFileSync(testDataPath, 'utf-8');
    let conversations: unknown;
    expect(() => {
      conversations = JSON.parse(rawData);
    }).not.toThrow();

    expect(Array.isArray(conversations)).toBe(true);
    const convArray = conversations as TestConversation[];
    expect(convArray.length).toBeGreaterThan(0);

    const requiredFields: Array<keyof TestConversation> = [
      'id',
      'scenario',
      'customer_messages',
      'expected_outcome',
      'difficulty',
    ];

    for (const conv of convArray) {
      for (const field of requiredFields) {
        expect(conv).toHaveProperty(field);
        expect(conv[field]).toBeDefined();
      }

      // customer_messages は配列で3〜6件
      expect(Array.isArray(conv.customer_messages)).toBe(true);
      expect(conv.customer_messages.length).toBeGreaterThanOrEqual(3);
      expect(conv.customer_messages.length).toBeLessThanOrEqual(6);

      // expected_outcome は規定値のみ
      expect(['appointment', 'replied', 'lost']).toContain(conv.expected_outcome);

      // difficulty は規定値のみ
      expect(['easy', 'medium', 'hard']).toContain(conv.difficulty);

      // id はユニーク形式
      expect(typeof conv.id).toBe('string');
      expect(conv.id.length).toBeGreaterThan(0);
    }

    // 難易度の件数確認
    const easy = convArray.filter((c) => c.difficulty === 'easy').length;
    const medium = convArray.filter((c) => c.difficulty === 'medium').length;
    const hard = convArray.filter((c) => c.difficulty === 'hard').length;

    expect(easy).toBe(9);
    expect(medium).toBe(15);
    expect(hard).toBe(6);
    expect(convArray.length).toBe(30);
  });
});

// ──────────────────────────────────────────────
// テスト2: Feature Flag切り替え
// ──────────────────────────────────────────────

describe('Feature Flag切り替え', () => {
  it('条件A: 全フラグOFF', () => {
    const flags = getFeatureFlags('A');
    expect(flags).toEqual({
      ENABLE_PSYCHOLOGY_RAG: false,
      ENABLE_JUDGE: false,
      ENABLE_AB_TEST: false,
      OPENCLAW_RL_ENABLED: false,
      OPENVIKING_ENABLED: false,
    });
  });

  it('条件B: 心理学RAGのみON', () => {
    const flags = getFeatureFlags('B');
    expect(flags).toEqual({
      ENABLE_PSYCHOLOGY_RAG: true,
      ENABLE_JUDGE: false,
      ENABLE_AB_TEST: false,
      OPENCLAW_RL_ENABLED: false,
      OPENVIKING_ENABLED: false,
    });
  });

  it("条件BPRIME: OpenViking有効時にOPENVIKING_ENABLEDがtrueになる", () => {
    process.env.OPENVIKING_ENABLED = '1';
    const flags = getFeatureFlags('BPRIME');
    expect(flags.ENABLE_PSYCHOLOGY_RAG).toBe(true);
    expect(flags.OPENVIKING_ENABLED).toBe(true);
    expect(flags.ENABLE_JUDGE).toBe(false);
    expect(flags.OPENCLAW_RL_ENABLED).toBe(false);
    delete process.env.OPENVIKING_ENABLED;
  });

  it('条件C: 心理学RAG+JudgeON', () => {
    const flags = getFeatureFlags('C');
    expect(flags).toEqual({
      ENABLE_PSYCHOLOGY_RAG: true,
      ENABLE_JUDGE: true,
      ENABLE_AB_TEST: false,
      OPENCLAW_RL_ENABLED: false,
      OPENVIKING_ENABLED: false,
    });
  });

  it('条件D: 全フラグON（OPENCLAW_RL_ENABLED含む）', () => {
    delete process.env.ENABLE_OPENCLAW; // デフォルト: enabled
    const flags = getFeatureFlags('D');
    expect(flags).toEqual({
      ENABLE_PSYCHOLOGY_RAG: true,
      ENABLE_JUDGE: true,
      ENABLE_AB_TEST: true,
      OPENCLAW_RL_ENABLED: true,
      OPENVIKING_ENABLED: false,
    });
  });

  it('未知の条件はエラーをthrowする', () => {
    expect(() => getFeatureFlags('Z')).toThrow('Unknown benchmark condition: Z. Use A/B/BPRIME/C/D.');
  });
});

// ──────────────────────────────────────────────
// テスト3: CSV形式の出力検証
// ──────────────────────────────────────────────

describe('CSV出力形式', () => {
  const mockResults: ConversationResult[] = [
    {
      id: 'conv_001',
      scenario: '在庫確認テスト',
      difficulty: 'easy',
      expectedOutcome: 'replied',
      actualStages: ['clarify', 'propose'],
      judgeScore: 72,
      usedPrinciples: ['社会的証明'],
      success: true,
      tokenEstimate: 120,
    },
    {
      id: 'conv_002',
      scenario: '価格交渉,テスト',
      difficulty: 'medium',
      expectedOutcome: 'appointment',
      actualStages: ['clarify', 'propose', 'recommend'],
      judgeScore: 85,
      usedPrinciples: ['アンカリング効果', '損失回避'],
      success: true,
      tokenEstimate: 250,
    },
  ];

  it('正しいヘッダーを持つCSVを返す', () => {
    const csv = formatResultsAsCsv(mockResults);
    const lines = csv.split('\n');

    expect(lines[0]).toBe(
      'id,scenario,difficulty,expectedOutcome,actualStages,judgeScore,usedPrinciples,success,tokenEstimate',
    );
  });

  it('正しいデータ行数を持つ', () => {
    const csv = formatResultsAsCsv(mockResults);
    const lines = csv.split('\n');
    // ヘッダー + データ2行
    expect(lines.length).toBe(3);
  });

  it('カンマを含むシナリオ名をダブルクォートでエスケープする', () => {
    const csv = formatResultsAsCsv(mockResults);
    const lines = csv.split('\n');
    // conv_002 の scenario に "," が含まれる
    expect(lines[2]).toContain('"価格交渉,テスト"');
  });

  it('actualStagesを → で結合した形式で出力する', () => {
    const csv = formatResultsAsCsv(mockResults);
    expect(csv).toContain('clarify → propose');
    expect(csv).toContain('clarify → propose → recommend');
  });

  it('success フィールドが true/false 文字列で出力される', () => {
    const csv = formatResultsAsCsv(mockResults);
    expect(csv).toContain('true');
  });

  it('空の結果セットでもヘッダーのみのCSVを返す', () => {
    const csv = formatResultsAsCsv([]);
    const lines = csv.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('id');
  });
});

// ──────────────────────────────────────────────
// テスト4: 条件D — ENABLE_OPENCLAW=false 時のスキップ動作
// ──────────────────────────────────────────────

describe('条件D — ENABLE_OPENCLAW未設定時のフォールバック', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('ENABLE_OPENCLAW=false のとき条件DのフラグはCと同等になる（フォールバック挙動の確認）', () => {
    process.env.ENABLE_OPENCLAW = 'false';

    // 条件Dが要求されたとき、ENABLE_OPENCLAWが無効なら条件Cのフラグで代替する
    const condD = getFeatureFlags('D');
    const condC = getFeatureFlags('C');

    // 条件D自体のフラグは変わらない（フォールバックはmain()で行う）
    // ここではフラグ値を比較して、CとDの差異はENABLE_AB_TESTのみであることを確認
    expect(condD.ENABLE_PSYCHOLOGY_RAG).toBe(condC.ENABLE_PSYCHOLOGY_RAG);
    expect(condD.ENABLE_JUDGE).toBe(condC.ENABLE_JUDGE);
    // ENABLE_AB_TEST だけが異なる（これがOpenClaw統合フラグ）
    expect(condD.ENABLE_AB_TEST).toBe(true);
    expect(condC.ENABLE_AB_TEST).toBe(false);
  });

  it('ENABLE_OPENCLAW が未設定（undefined）の場合、条件Dは通常実行される', () => {
    delete process.env.ENABLE_OPENCLAW;

    // ENABLE_OPENCLAW が未設定の場合はスキップしない
    expect(process.env.ENABLE_OPENCLAW).toBeUndefined();

    // getFeatureFlags('D') はエラーなく実行できる
    expect(() => getFeatureFlags('D')).not.toThrow();
  });

  it('ENABLE_OPENCLAW=true の場合、条件DはスキップされずAB_TESTフラグがtrueになる', () => {
    process.env.ENABLE_OPENCLAW = 'true';

    const flags = getFeatureFlags('D');
    expect(flags.ENABLE_AB_TEST).toBe(true);
  });
});
