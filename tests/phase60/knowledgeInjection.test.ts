// tests/phase60/knowledgeInjection.test.ts
// Phase60-A: ナレッジ注入 — 4機能へのプロンプト注入を検証

// ─── トップレベルモック（hoisting対応） ───────────────────────────────────────
const MOCK_FORMATTED = '1. [book] 返報性の原理 (score: 0.89)';
const MOCK_KNOWLEDGE_CTX = {
  results: [{ text: '返報性の原理', score: 0.89, source: 'book' }],
};

const mockSearchKnowledge = jest.fn();
const mockFormatKnowledge = jest.fn();

jest.mock('../../src/lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: (...args: unknown[]) => mockSearchKnowledge(...args),
  formatKnowledgeContext: (...args: unknown[]) => mockFormatKnowledge(...args),
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

// ─────────────────────────────────────────────────────────────────────────────
// テスト 7・8: チューニングルールAI提案
// ─────────────────────────────────────────────────────────────────────────────
describe('[60A-2] チューニングルールAI提案 — ナレッジ注入', () => {
  let mockFetch: jest.Mock;
  const GROQ_RESPONSE = {
    choices: [{ message: { content: '{"trigger_pattern":"価格","instruction":"詳細案内","priority":5,"reason":"改善が必要"}' } }],
  };

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key-groq';
    mockSearchKnowledge.mockResolvedValue(MOCK_KNOWLEDGE_CTX);
    mockFormatKnowledge.mockReturnValue(MOCK_FORMATTED);

    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(GROQ_RESPONSE),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    jest.clearAllMocks();
  });

  // 7. プロンプトに「参考ナレッジ」セクションが含まれる
  it('7. プロンプトに「参考ナレッジ」セクションが含まれる', async () => {
    await callGroq8bSuggest(
      '価格を教えてください',
      '料金プランをご案内します',
      MOCK_FORMATTED,
      '',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('参考ナレッジ');
    expect(body.messages[0].content).toContain(MOCK_FORMATTED);
  });

  // 8. プロンプトに「既存チューニングルール」セクションが含まれる
  it('8. プロンプトに「既存チューニングルール」セクションが含まれる', async () => {
    const existingRules = '- [価格について] 料金プランを詳しく案内する';

    await callGroq8bSuggest(
      '配送はどのくらいかかりますか',
      '通常3〜5営業日です',
      '',
      existingRules,
    );

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('既存チューニングルール');
    expect(body.messages[0].content).toContain(existingRules);
  });

  it('knowledgeSection と existingRulesSection が空のときセクション未追加', async () => {
    await callGroq8bSuggest('質問', '回答', '', '');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).not.toContain('参考ナレッジ');
    expect(body.messages[0].content).not.toContain('既存チューニングルール');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 9・10: Judge評価フィードバック
// ─────────────────────────────────────────────────────────────────────────────
describe('[60A-3] Judge評価 — ナレッジ注入', () => {
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
    mockSearchKnowledge.mockResolvedValue(MOCK_KNOWLEDGE_CTX);
    mockFormatKnowledge.mockReturnValue(MOCK_FORMATTED);
    mockCallGeminiJudge.mockResolvedValue(EVAL_JSON);

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 'sess-uuid-1', tenant_id: 'tenant-test' }] })
      .mockResolvedValueOnce({ rows: [
        { role: 'user', content: '価格を教えてください', created_at: new Date() },
        { role: 'assistant', content: '料金プランをご案内します', created_at: new Date() },
      ]})
      .mockResolvedValueOnce({ rows: [{ trigger_pattern: '価格', expected_behavior: '詳細案内' }] })
      .mockResolvedValue({ rows: [] });
  });

  // 9. プロンプトに「心理学ナレッジ」セクションが含まれる
  it('9. Geminiに渡すプロンプトに「心理学ナレッジ」セクションが含まれる', async () => {
    await evaluateSession('session-abc');

    expect(mockCallGeminiJudge).toHaveBeenCalledTimes(1);
    const calledPrompt: string = mockCallGeminiJudge.mock.calls[0]?.[0] ?? '';
    expect(calledPrompt).toContain('このテナントの心理学ナレッジ');
    expect(calledPrompt).toContain(MOCK_FORMATTED);
  });

  // 10. プロンプトに「チューニングルール」セクションが含まれる
  it('10. Geminiに渡すプロンプトに「チューニングルール」セクションが含まれる', async () => {
    await evaluateSession('session-abc');

    const calledPrompt: string = mockCallGeminiJudge.mock.calls[0]?.[0] ?? '';
    expect(calledPrompt).toContain('このテナントのチューニングルール');
    expect(calledPrompt).toContain('価格');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 11: ギャップ推薦 — pgvector使用確認
// ─────────────────────────────────────────────────────────────────────────────
describe('[60A-4] ナレッジギャップAI推薦 — pgvector使用', () => {
  const GAPS = [{ id: 1, user_question: '返品方法を教えてください' }];
  const GEMINI_RESPONSE = JSON.stringify([
    { index: 1, recommended_action: '返品FAQを追加する', suggested_answer: '購入後30日以内に返品できます' },
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchKnowledge.mockResolvedValue(MOCK_KNOWLEDGE_CTX);
    mockFormatKnowledge.mockReturnValue(MOCK_FORMATTED);
    mockCallGeminiJudge.mockResolvedValue(GEMINI_RESPONSE);

    mockDbQuery
      .mockResolvedValueOnce({ rows: GAPS })
      .mockResolvedValue({ rows: [] });
  });

  // 11. faq_docs ILIKE ではなく searchKnowledgeForSuggestion が使われている
  it('11. searchKnowledgeForSuggestion が呼ばれ、faq_docs クエリが呼ばれない', async () => {
    await generateRecommendations('tenant-test');

    expect(mockSearchKnowledge).toHaveBeenCalledWith('tenant-test', GAPS[0]!.user_question);

    const allSqlCalls: string[] = (mockDbQuery.mock.calls as [string, unknown[]][])
      .filter(([sql]) => typeof sql === 'string')
      .map(([sql]) => sql as string);
    expect(allSqlCalls.every((sql) => !sql.includes('faq_docs'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 12: AIアシスタント — pgvector使用確認
// ─────────────────────────────────────────────────────────────────────────────
describe('[60A-5] 管理画面AIアシスタント — pgvector使用', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-key-groq';
    mockSearchKnowledge.mockResolvedValue(MOCK_KNOWLEDGE_CTX);
    mockFormatKnowledge.mockReturnValue(MOCK_FORMATTED);

    mockFetch = jest.fn()
      // detectIntent → business_faq
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'business_faq' } }] }),
      })
      // callGroq70b
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

  // 12. faq_docs ILIKE ではなく searchKnowledgeForSuggestion が使われている
  it('12. searchKnowledgeForSuggestion が呼ばれ、faq_docs クエリが呼ばれない', async () => {
    const app = express();
    app.use(express.json());
    registerAdminAiAssistRoutes(app);

    await supertest(app)
      .post('/v1/admin/ai-assist/chat')
      .send({ message: '返品方法を教えてください' });

    expect(mockSearchKnowledge).toHaveBeenCalledWith('tenant-test', '返品方法を教えてください');

    const dbSqlCalls: string[] = (mockDbQuery.mock.calls as [string, unknown[]][])
      .filter(([sql]) => typeof sql === 'string')
      .map(([sql]) => sql as string);
    expect(dbSqlCalls.every((sql) => !sql.includes('faq_docs'))).toBe(true);
  });
});
