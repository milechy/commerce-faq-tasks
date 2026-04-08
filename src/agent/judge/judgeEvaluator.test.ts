// src/agent/judge/judgeEvaluator.test.ts
// Phase45 Stream A: unit tests for judgeEvaluator
// Updated to mock callGeminiJudge (implementation migrated from Groq to Gemini)

jest.mock('../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn(),
}));

jest.mock('../../lib/db', () => ({
  getPool: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

// Phase52h: Notification側の副作用をテスト内で切り離す
jest.mock('../../lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

// Phase60-A: knowledgeSearchUtil をモック（pgvector/embedding は外部依存）
jest.mock('../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn().mockResolvedValue({ results: [] }),
  formatKnowledgeContext: jest.fn().mockReturnValue(''),
}));

// Phase60-B: crossTenantContext をモック（DBアクセス不要）
jest.mock('../../lib/crossTenantContext', () => ({
  getCrossTenantContext: jest.fn().mockResolvedValue({
    avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [],
    effectiveRulePatterns: [], totalTenants: 0, dataAsOf: '',
  }),
  formatCrossTenantContext: jest.fn().mockReturnValue(''),
}));

import { callGeminiJudge } from '../../lib/gemini/client';
import { getPool } from '../../lib/db';
import { readFile } from 'fs/promises';
import { evaluateSession } from './judgeEvaluator';

const mockCallGroq = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;
const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

const PROMPT_TEMPLATE =
  'Judge prompt template\n{{CONVERSATION_LOG}}\nOutput JSON only.';

function makeGroqResponse(overrides: Partial<{
  overall_score: number;
  psychology_fit_score: number;
  customer_reaction_score: number;
  stage_progress_score: number;
  taboo_violation_score: number;
}>): string {
  const scores = {
    overall_score: 75,
    psychology_fit_score: 80,
    customer_reaction_score: 70,
    stage_progress_score: 75,
    taboo_violation_score: 90,
    ...overrides,
  };
  return JSON.stringify({
    ...scores,
    feedback: {
      psychology_fit: 'Good use of mirroring',
      customer_reaction: 'Customer responded positively',
      stage_progress: 'Natural flow from clarify to propose',
      taboo_violation: '違反なし',
      summary: '全体的に良好な会話でした。',
    },
    suggested_rules: [
      {
        rule_text: 'Always clarify budget before proposing',
        reason: 'Helps match products to customer needs',
        priority: 'high',
      },
    ],
  });
}

function makeMockPool(queryImpl?: jest.Mock): jest.Mocked<{ query: jest.Mock }> {
  const query = queryImpl ?? jest.fn();
  return { query } as jest.Mocked<{ query: jest.Mock }>;
}

describe('evaluateSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: prompt file loads successfully
    mockReadFile.mockResolvedValue(PROMPT_TEMPLATE as never);
  });

  it('1. successful evaluation — correct scores computed, saveEvaluation called', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    // chat_sessions query
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-123', tenant_id: 'tenant-abc' }] })
      // chat_messages query
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '中古車の予算は？', created_at: new Date() },
          { role: 'assistant', content: 'ご予算の目安を教えてください。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [] });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({
      overall_score: 75,
      psychology_fit_score: 80,
      customer_reaction_score: 70,
      stage_progress_score: 75,
      taboo_violation_score: 90,
    }));

    const result = await evaluateSession('session-123');

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(75);
    expect(result!.psychology_fit_score).toBe(80);
    expect(result!.customer_reaction_score).toBe(70);
    expect(result!.stage_progress_score).toBe(75);
    expect(result!.taboo_violation_score).toBe(90);

    // INSERT was called with tenant_id and session_id (index 3 after Phase60-A tuning_rules SELECT)
    const insertCall = mockPool.query.mock.calls[3]!;
    expect(insertCall[1]).toContain('tenant-abc');
    expect(insertCall[1]).toContain('session-123');
  });

  it('2. low score triggers tuning_rules insert (score < 60)', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-low', tenant_id: 'tenant-low' }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '商品が欲しい', created_at: new Date() },
          { role: 'assistant', content: '商品Aです。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [] })
      // INSERT tuning_rules
      .mockResolvedValueOnce({ rows: [] });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({
      overall_score: 30,
      psychology_fit_score: 20,
      customer_reaction_score: 30,
      stage_progress_score: 40,
      taboo_violation_score: 50,
    }));

    const result = await evaluateSession('session-low');

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(30);

    // Should have called INSERT for tuning_rules (5th query call after Phase60-A)
    expect(mockPool.query.mock.calls.length).toBeGreaterThanOrEqual(5);
    const tuningInsertCall = mockPool.query.mock.calls[4]!;
    expect(tuningInsertCall[0]).toContain('tuning_rules');
  });

  it('3. high score does NOT insert tuning_rules (score >= 60)', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-high', tenant_id: 'tenant-high' }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: '予算200万で家族4人', created_at: new Date() },
          { role: 'assistant', content: 'ファミリー向けのシエンタが198万円で...', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [] });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({
      overall_score: 82,
      psychology_fit_score: 85,
      customer_reaction_score: 80,
      stage_progress_score: 82,
      taboo_violation_score: 95,
    }));

    const result = await evaluateSession('session-high');

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(82);

    // 4 queries: sessions, messages, tuning_rules SELECT (Phase60-A), INSERT evaluations
    // tuning_rules INSERT should NOT be called (score >= threshold)
    expect(mockPool.query.mock.calls.length).toBe(4);
    const queryTexts = mockPool.query.mock.calls.map((c) => c[0] as string);
    const insertCalls = queryTexts.filter((q) => q.includes('INSERT') && q.includes('tuning_rules'));
    expect(insertCalls.length).toBe(0);
  });

  it('4. Groq failure → returns null, does not throw', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-fail', tenant_id: 'tenant-fail' }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: 'hi', created_at: new Date() },
          { role: 'assistant', content: 'hello', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] });

    // Both attempts fail
    mockCallGroq
      .mockRejectedValueOnce(new Error('Groq network error'))
      .mockRejectedValueOnce(new Error('Groq network error'));

    await expect(evaluateSession('session-grq-fail')).resolves.toBeNull();
  });

  it('5. DB failure → returns null, does not throw', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    // chat_sessions query throws
    mockPool.query.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(evaluateSession('session-db-fail')).resolves.toBeNull();
  });

  it('6. Messages truncated to 200 chars in conversation log', async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool as any);

    const longContent = 'あ'.repeat(300);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'internal-uuid-trunc', tenant_id: 'tenant-trunc' }] })
      .mockResolvedValueOnce({
        rows: [
          { role: 'user', content: longContent, created_at: new Date() },
          { role: 'assistant', content: '承知しました。', created_at: new Date() },
        ],
      })
      // Phase60-A: tuning_rules SELECT
      .mockResolvedValueOnce({ rows: [] })
      // INSERT conversation_evaluations
      .mockResolvedValueOnce({ rows: [] });

    mockCallGroq.mockResolvedValueOnce(makeGroqResponse({ overall_score: 70 }));

    await evaluateSession('session-trunc');

    expect(mockCallGroq).toHaveBeenCalledTimes(1);
    const callArgs = mockCallGroq.mock.calls[0]!;
    // callGeminiJudge takes a single string prompt argument
    const promptArg = callArgs[0] as string;

    // 200 chars of 'あ' should be present
    expect(promptArg).toContain('あ'.repeat(200));
    // 201st char should not be present (300 chars would be present if not truncated)
    expect(promptArg).not.toContain('あ'.repeat(201));
  });
});
