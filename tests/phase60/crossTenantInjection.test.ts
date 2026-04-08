// tests/phase60/crossTenantInjection.test.ts
// Phase60-B: クロステナント統計注入 — 4機能へのプロンプト注入を検証

// ─── トップレベルモック（hoisting対応） ───────────────────────────────────────
const MOCK_FORMATTED_KNOWLEDGE = '1. [book] 返報性の原理 (score: 0.89)';
const MOCK_CROSS_TENANT_FORMATTED = '## クロステナント統計（匿名集計）\n- 全体平均スコア: 総合72.5点、心理適合68点、顧客反応75点、商談進展70点';

const mockSearchKnowledge = jest.fn();
const mockFormatKnowledge = jest.fn();
const mockGetCrossTenantContext = jest.fn();
const mockFormatCrossTenantContext = jest.fn();

jest.mock('../../src/lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: (...args: unknown[]) => mockSearchKnowledge(...args),
  formatKnowledgeContext: (...args: unknown[]) => mockFormatKnowledge(...args),
}));

jest.mock('../../src/lib/crossTenantContext', () => ({
  getCrossTenantContext: (...args: unknown[]) => mockGetCrossTenantContext(...args),
  formatCrossTenantContext: (...args: unknown[]) => mockFormatCrossTenantContext(...args),
}));

jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: { role: 'super_admin', tenant_id: 'tenant-test' },
      email: 'test@example.com',
    };
    next();
  },
}));

const mockDbQuery = jest.fn();
jest.mock('../../src/lib/db', () => ({
  getPool: () => ({ query: mockDbQuery }),
  pool: null,
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockCallGeminiJudge = jest.fn();
jest.mock('../../src/lib/gemini/client', () => ({
  callGeminiJudge: (...args: unknown[]) => mockCallGeminiJudge(...args),
}));

jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

// ─── 静的 import ──────────────────────────────────────────────────────────────
import express from 'express';
import supertest from 'supertest';
import { callGroq8bSuggest } from '../../src/api/admin/tuning/routes';
import { generateRecommendations } from '../../src/agent/gap/gapRecommender';
import { evaluateSession } from '../../src/agent/judge/judgeEvaluator';
import { registerAdminAiAssistRoutes } from '../../src/api/admin/ai-assist/routes';

const EMPTY_CROSS_TENANT = {
  avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [],
  effectiveRulePatterns: [], totalTenants: 0, dataAsOf: '',
};

// ─────────────────────────────────────────────────────────────────────────────
// テスト 13: チューニングルールAI提案 — クロステナント注入
// ─────────────────────────────────────────────────────────────────────────────
describe('[60B-2] チューニングルールAI提案 — クロステナント注入', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key-groq';
    mockSearchKnowledge.mockResolvedValue({ results: [] });
    mockFormatKnowledge.mockReturnValue('');
    mockGetCrossTenantContext.mockResolvedValue(EMPTY_CROSS_TENANT);
    mockFormatCrossTenantContext.mockReturnValue(MOCK_CROSS_TENANT_FORMATTED);

    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"trigger_pattern":"価格","instruction":"詳細案内","priority":5,"reason":"改善が必要"}' } }] }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    jest.clearAllMocks();
  });

  // 13. プロンプトにクロステナント統計が含まれる
  it('13. callGroq8bSuggest — プロンプトにクロステナント統計が含まれる', async () => {
    await callGroq8bSuggest(
      '価格を教えてください',
      '料金プランをご案内します',
      '',
      '',
      MOCK_CROSS_TENANT_FORMATTED,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('クロステナント統計');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 14: Judge評価 — クロステナント注入
// ─────────────────────────────────────────────────────────────────────────────
describe('[60B-3] Judge評価 — クロステナント注入', () => {
  const EVAL_JSON = JSON.stringify({
    overall_score: 75,
    psychology_fit_score: 70,
    customer_reaction_score: 80,
    stage_progress_score: 75,
    taboo_violation_score: 100,
    feedback: {
      psychology_fit: 'OK', customer_reaction: 'OK', stage_progress: 'OK',
      taboo_violation: '違反なし', summary: 'OK',
    },
    suggested_rules: [],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchKnowledge.mockResolvedValue({ results: [] });
    mockFormatKnowledge.mockReturnValue('');
    mockGetCrossTenantContext.mockResolvedValue(EMPTY_CROSS_TENANT);
    mockFormatCrossTenantContext.mockReturnValue(MOCK_CROSS_TENANT_FORMATTED);
    mockCallGeminiJudge.mockResolvedValue(EVAL_JSON);

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 'sess-uuid-1', tenant_id: 'tenant-test' }] })
      .mockResolvedValueOnce({ rows: [
        { role: 'user', content: '価格を教えてください', created_at: new Date() },
        { role: 'assistant', content: '料金プランをご案内します', created_at: new Date() },
      ]})
      .mockResolvedValueOnce({ rows: [] })  // tuning_rules SELECT
      .mockResolvedValue({ rows: [] });
  });

  // 14. プロンプトにクロステナント統計セクションが含まれる
  it('14. Geminiに渡すプロンプトにクロステナント統計が含まれる', async () => {
    await evaluateSession('session-abc');

    expect(mockCallGeminiJudge).toHaveBeenCalledTimes(1);
    const calledPrompt: string = mockCallGeminiJudge.mock.calls[0]?.[0] ?? '';
    expect(calledPrompt).toContain('クロステナント統計');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 15: ギャップ推薦 — クロステナント注入
// ─────────────────────────────────────────────────────────────────────────────
describe('[60B-4] ナレッジギャップAI推薦 — クロステナント注入', () => {
  const GAPS = [{ id: 1, user_question: '返品方法を教えてください' }];
  const GEMINI_RESPONSE = JSON.stringify([
    { index: 1, recommended_action: '返品FAQを追加する', suggested_answer: '購入後30日以内に返品できます' },
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchKnowledge.mockResolvedValue({ results: [] });
    mockFormatKnowledge.mockReturnValue('');
    mockGetCrossTenantContext.mockResolvedValue(EMPTY_CROSS_TENANT);
    mockFormatCrossTenantContext.mockReturnValue(MOCK_CROSS_TENANT_FORMATTED);
    mockCallGeminiJudge.mockResolvedValue(GEMINI_RESPONSE);

    mockDbQuery
      .mockResolvedValueOnce({ rows: GAPS })
      .mockResolvedValue({ rows: [] });
  });

  // 15. プロンプトにクロステナント統計が含まれる
  it('15. Geminiに渡すプロンプトにクロステナント統計が含まれる', async () => {
    await generateRecommendations('tenant-test');

    expect(mockCallGeminiJudge).toHaveBeenCalledTimes(1);
    const calledPrompt: string = mockCallGeminiJudge.mock.calls[0]?.[0] ?? '';
    expect(calledPrompt).toContain('クロステナント統計');
  });

  // 16. getCrossTenantContext が呼ばれる
  it('16. getCrossTenantContext が呼ばれる', async () => {
    await generateRecommendations('tenant-test');

    expect(mockGetCrossTenantContext).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 17・18: AIアシスタント — クロステナント注入
// ─────────────────────────────────────────────────────────────────────────────
describe('[60B-5] 管理画面AIアシスタント — クロステナント注入', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-key-groq';
    mockSearchKnowledge.mockResolvedValue({ results: [] });
    mockFormatKnowledge.mockReturnValue('');
    mockGetCrossTenantContext.mockResolvedValue(EMPTY_CROSS_TENANT);
    mockFormatCrossTenantContext.mockReturnValue(MOCK_CROSS_TENANT_FORMATTED);

    mockFetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'business_faq' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '詳細はサポートまでお問い合わせください' } }] }),
      });
    global.fetch = mockFetch as unknown as typeof fetch;

    mockDbQuery.mockResolvedValue({ rows: [{ id: 'fb-001' }] });
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
  });

  // 17. getCrossTenantContext が呼ばれる
  it('17. getCrossTenantContext が呼ばれる', async () => {
    const app = express();
    app.use(express.json());
    registerAdminAiAssistRoutes(app);

    await supertest(app)
      .post('/v1/admin/ai-assist/chat')
      .send({ message: '返品方法を教えてください' });

    expect(mockGetCrossTenantContext).toHaveBeenCalledTimes(1);
  });

  // 18. クロステナント統計がGroqに渡るシステムプロンプトに含まれる
  it('18. クロステナント統計がGroq 70bのシステムプロンプトに含まれる', async () => {
    const app = express();
    app.use(express.json());
    registerAdminAiAssistRoutes(app);

    await supertest(app)
      .post('/v1/admin/ai-assist/chat')
      .send({ message: '返品方法を教えてください' });

    // 2回目のfetch呼び出しがGroq 70b
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string);
    const systemContent: string = secondBody.messages[0].content;
    expect(systemContent).toContain('クロステナント統計');
  });
});
