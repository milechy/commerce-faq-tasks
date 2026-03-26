// src/agent/judge/evaluationAnalyzer.test.ts
// Phase45: evaluationAnalyzer のユニットテスト

jest.mock('../llm/groqClient', () => ({
  callGroqWith429Retry: jest.fn(),
}));

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
    // ON CONFLICT DO NOTHING が含まれていること
    expect(insertCalls[0][0]).toContain('ON CONFLICT DO NOTHING');
  });

  it('4. 重複ルールは挿入されない（ON CONFLICT DO NOTHING）', async () => {
    const mockRepo = createMockRepo(sampleEvaluations);
    const mockPool = createMockPool();
    mockCallGroq.mockResolvedValueOnce(mockRulesResponse);

    await analyzeTuningRules('tenant-test', mockRepo as any, mockPool as any);

    // INSERT文に ON CONFLICT DO NOTHING が含まれていること
    const calls = (mockPool.query as jest.Mock).mock.calls;
    for (const call of calls) {
      if (call[0].includes('INSERT')) {
        expect(call[0]).toContain('ON CONFLICT DO NOTHING');
      }
    }
  });
});
