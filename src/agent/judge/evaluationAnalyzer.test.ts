// src/agent/judge/evaluationAnalyzer.test.ts
// Phase45: evaluationAnalyzer のユニットテスト

jest.mock('../llm/groqClient', () => ({
  callGroqWith429Retry: jest.fn(),
}));

import fs from 'fs';
import path from 'path';

import { callGroqWith429Retry } from '../llm/groqClient';
import { analyzeTuningRules } from './evaluationAnalyzer';
import type { ConversationEvaluation } from './evaluationRepository';

const mockCallGroq = callGroqWith429Retry as jest.MockedFunction<typeof callGroqWith429Retry>;

// モック evaluationRepo
function createMockRepo(evaluations: ConversationEvaluation[]) {
  return {
    saveEvaluation: jest.fn(),
    getEvaluationsByTenant: jest.fn().mockResolvedValue(evaluations),
    getEvaluationBySession: jest.fn(),
    getAggregateStats: jest.fn(),
  };
}

// モック pool
function createMockPool() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

const sampleEvaluations: ConversationEvaluation[] = [
  {
    id: 1,
    tenantId: 'tenant-test',
    sessionId: 'session-1',
    score: 80,
    usedPrinciples: ['社会的証明', '希少性'],
    effectivePrinciples: ['社会的証明'],
    failedPrinciples: ['希少性'],
    evaluationAxes: {
      principle_appropriateness: 85,
      customer_reaction: 80,
      stage_progression: 75,
      contraindication_compliance: 90,
    },
    notes: 'テスト評価1',
  },
  {
    id: 2,
    tenantId: 'tenant-test',
    sessionId: 'session-2',
    score: 60,
    usedPrinciples: ['社会的証明'],
    effectivePrinciples: ['社会的証明'],
    failedPrinciples: [],
    evaluationAxes: {
      principle_appropriateness: 60,
      customer_reaction: 65,
      stage_progression: 55,
      contraindication_compliance: 60,
    },
    notes: 'テスト評価2',
  },
  {
    id: 3,
    tenantId: 'tenant-test',
    sessionId: 'session-3',
    score: 30,
    usedPrinciples: [],
    effectivePrinciples: [],
    failedPrinciples: ['希少性', 'アンカリング効果'],
    evaluationAxes: {
      principle_appropriateness: 20,
      customer_reaction: 35,
      stage_progression: 30,
      contraindication_compliance: 40,
    },
    notes: 'テスト評価3',
  },
];

const mockRulesResponse = JSON.stringify([
  {
    triggerPattern: '顧客が価格について質問したとき',
    expectedBehavior: '社会的証明を活用して他の顧客の選択を示す',
  },
  {
    triggerPattern: '顧客が比較を求めたとき',
    expectedBehavior: 'アンカリング効果で価値を示してから比較する',
  },
  {
    triggerPattern: '顧客が購入をためらうとき',
    expectedBehavior: '希少性原則を適切に（強引でなく）活用する',
  },
]);

describe('analyzeTuningRules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1. 直近50件の評価から有効/失敗原則を正しく集計する', async () => {
    const mockRepo = createMockRepo(sampleEvaluations);
    const mockPool = createMockPool();
    mockCallGroq.mockResolvedValueOnce(mockRulesResponse);

    await analyzeTuningRules('tenant-test', mockRepo as any, mockPool as any);

    expect(mockRepo.getEvaluationsByTenant).toHaveBeenCalledWith('tenant-test', 50, 0);

    // Groqへのpromptに集計結果が含まれること
    const callArgs = mockCallGroq.mock.calls[0]!;
    const userMessage = callArgs[0].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('社会的証明'); // 効果的な原則
  });

  it('2. Groq 8b でルール提案が最大3件生成される', async () => {
    const mockRepo = createMockRepo(sampleEvaluations);
    const mockPool = createMockPool();
    mockCallGroq.mockResolvedValueOnce(mockRulesResponse);

    const result = await analyzeTuningRules('tenant-test', mockRepo as any, mockPool as any);

    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('triggerPattern');
    expect(result[0]).toHaveProperty('expectedBehavior');
    expect(result[0]).toHaveProperty('evidence');
  });

  it('3. tuning_rules への INSERT が行われる', async () => {
    const mockRepo = createMockRepo(sampleEvaluations);
    const mockPool = createMockPool();
    mockCallGroq.mockResolvedValueOnce(mockRulesResponse);

    await analyzeTuningRules('tenant-test', mockRepo as any, mockPool as any);

    expect(mockPool.query).toHaveBeenCalled();
    // INSERTが呼ばれていること
    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (call: any[]) => call[0].includes('INSERT INTO tuning_rules'),
    );
    expect(insertCalls.length).toBeGreaterThan(0);
    // source='judge' が含まれていること
    expect(insertCalls[0][0]).toContain("'judge'");
    // ON CONFLICT が一意制約のターゲット付きで含まれていること（詳細は test 4）
    expect(insertCalls[0][0]).toContain('ON CONFLICT (tenant_id, trigger_pattern) DO NOTHING');
  });

  it('3c. INSERT文でis_activeがfalseに明示される（列を省略するとスキーマ既定DEFAULT trueで無断有効化されるため）', async () => {
    const mockRepo = createMockRepo(sampleEvaluations);
    const mockPool = createMockPool();
    mockCallGroq.mockResolvedValueOnce(mockRulesResponse);

    await analyzeTuningRules('tenant-test', mockRepo as any, mockPool as any);

    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (call: any[]) => call[0].includes('INSERT INTO tuning_rules'),
    );
    expect(insertCalls[0][0]).toContain('is_active');
    expect(insertCalls[0][0]).toContain('false');
  });

  it('3b. INSERT文にevidence列が含まれ、返り値と同じevidenceがJSON永続化される（GID 1215916762299598: 以前は計算のみでDB未保存だった）', async () => {
    const mockRepo = createMockRepo(sampleEvaluations);
    const mockPool = createMockPool();
    mockCallGroq.mockResolvedValueOnce(mockRulesResponse);

    const result = await analyzeTuningRules('tenant-test', mockRepo as any, mockPool as any);

    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (call: any[]) => call[0].includes('INSERT INTO tuning_rules'),
    );
    expect(insertCalls[0][0]).toContain('evidence');

    const [, params] = insertCalls[0];
    const persistedEvidence = JSON.parse(params[params.length - 1]);
    expect(persistedEvidence).toEqual(result[0]!.evidence);
  });

  it('4. 重複ルールは挿入されない — ON CONFLICT が一意制約のターゲットを明示している', async () => {
    // 旧テストは「SQL文字列に ON CONFLICT DO NOTHING が含まれること」しか見ていなかった。
    // ターゲット無しの ON CONFLICT は SERIAL の id にしか反応できず実質 no-op なので、
    // 重複が入り放題の状態でもこのテストは通り続けていた（誤った安心感）。
    // 重複排除が本当に効く条件は「ターゲットが実在の一意制約と一致していること」なので、
    // そこを検証する。
    const mockRepo = createMockRepo(sampleEvaluations);
    const mockPool = createMockPool();
    mockCallGroq.mockResolvedValueOnce(mockRulesResponse);

    await analyzeTuningRules('tenant-test', mockRepo as any, mockPool as any);

    const insertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO tuning_rules'),
    );
    expect(insertCalls.length).toBeGreaterThan(0);

    for (const call of insertCalls) {
      // ターゲット無しの `ON CONFLICT DO NOTHING` は退行とみなす
      expect(call[0]).not.toMatch(/ON CONFLICT\s+DO NOTHING/);
      expect(call[0]).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*trigger_pattern\s*\)\s*DO NOTHING/);
    }
  });

  it('5. ON CONFLICT のターゲットが phase75 マイグレーションの一意インデックスと一致している（コードとスキーマの乖離防止）', () => {
    // ON CONFLICT のターゲットは、実在する一意制約と一致しないと Postgres が
    // 「there is no unique or exclusion constraint matching the ON CONFLICT specification」
    // を返して INSERT が全て失敗する。コード側だけ・スキーマ側だけを直す片肺変更を防ぐため、
    // 両者を突き合わせる。
    const migrationPath = path.join(__dirname, '../../migrations/phase75_tuning_rules_unique.sql');
    const migration = fs.readFileSync(migrationPath, 'utf-8');

    // マイグレーションが (tenant_id, trigger_pattern) の UNIQUE INDEX を作っていること
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?ON tuning_rules\s*\(\s*tenant_id\s*,\s*trigger_pattern\s*\)/,
    );

    // コード側の ON CONFLICT ターゲットが同じ列の組であること
    const analyzerSrc = fs.readFileSync(path.join(__dirname, 'evaluationAnalyzer.ts'), 'utf-8');
    expect(analyzerSrc).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*trigger_pattern\s*\)/);

    const judgeSrc = fs.readFileSync(path.join(__dirname, 'judgeEvaluator.ts'), 'utf-8');
    expect(judgeSrc).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*trigger_pattern\s*\)/);
  });

  it('6. conversation_evaluations 側も同様にコードとスキーマが一致している', () => {
    const migrationPath = path.join(
      __dirname,
      '../../migrations/phase75_conversation_evaluations_unique.sql',
    );
    const migration = fs.readFileSync(migrationPath, 'utf-8');
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?ON conversation_evaluations\s*\(\s*tenant_id\s*,\s*session_id\s*\)/,
    );

    const judgeSrc = fs.readFileSync(path.join(__dirname, 'judgeEvaluator.ts'), 'utf-8');
    expect(judgeSrc).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*session_id\s*\)\s*DO NOTHING/);
    // ターゲット無しの退行が残っていないこと
    expect(judgeSrc).not.toMatch(/ON CONFLICT\s+DO NOTHING/);
  });
});
