// tests/phase60/deepResearchFeature.test.ts
// Phase60-C: deep_researchフィーチャーフラグ + 3提案機能への注入テスト

// ─── トップレベルモック ───────────────────────────────────────────────────────

const mockDbQuery = jest.fn();
jest.mock('../../src/lib/db', () => ({
  getPool: () => ({ query: mockDbQuery }),
  pool: null,
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockSearchKnowledge = jest.fn();
const mockFormatKnowledge = jest.fn();
jest.mock('../../src/lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: (...args: unknown[]) => mockSearchKnowledge(...args),
  formatKnowledgeContext: (...args: unknown[]) => mockFormatKnowledge(...args),
}));

const mockGetCrossTenant = jest.fn();
const mockFormatCrossTenant = jest.fn();
jest.mock('../../src/lib/crossTenantContext', () => ({
  getCrossTenantContext: (...args: unknown[]) => mockGetCrossTenant(...args),
  formatCrossTenantContext: (...args: unknown[]) => mockFormatCrossTenant(...args),
}));

// research モジュールをモック
const mockSearch = jest.fn();
const mockGetResearchProvider = jest.fn();
const mockIsDeepResearchEnabled = jest.fn();
jest.mock('../../src/lib/research', () => ({
  getResearchProvider: () => mockGetResearchProvider(),
}));
jest.mock('../../src/lib/research/featureCheck', () => ({
  isDeepResearchEnabled: (...args: unknown[]) => mockIsDeepResearchEnabled(...args),
}));
jest.mock('../../src/lib/research/queryBuilder', () => ({
  buildResearchQuery: (ctx: { userMessage: string }) => `研究クエリ: ${ctx.userMessage}`,
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

jest.mock('../../src/lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

const mockCallGeminiJudge = jest.fn();
jest.mock('../../src/lib/gemini/client', () => ({
  callGeminiJudge: (...args: unknown[]) => mockCallGeminiJudge(...args),
}));

// ─── 静的 import ──────────────────────────────────────────────────────────────
import express from 'express';
import supertest from 'supertest';
import { callGroq8bSuggest } from '../../src/api/admin/tuning/routes';
import { generateRecommendations } from '../../src/agent/gap/gapRecommender';
import { registerAdminAiAssistRoutes } from '../../src/api/admin/ai-assist/routes';

const EMPTY_CROSS_TENANT = {
  avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [],
  effectiveRulePatterns: [], totalTenants: 0, dataAsOf: '',
};

const MOCK_RESEARCH_RESULT = {
  summary: '最新の消費者心理研究によると...',
  citations: ['https://research.example.com/1'],
  query: 'テスト',
  provider: 'perplexity',
};

// ─────────────────────────────────────────────────────────────────────────────
// テスト 13-14: チューニングAI提案
// ─────────────────────────────────────────────────────────────────────────────
describe('[60C] チューニングAI提案 — ディープリサーチ注入', () => {
  let mockFetchGroq: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['GROQ_API_KEY'] = 'test-groq-key';
    mockSearchKnowledge.mockResolvedValue({ results: [] });
    mockFormatKnowledge.mockReturnValue('');
    mockGetCrossTenant.mockResolvedValue(EMPTY_CROSS_TENANT);
    mockFormatCrossTenant.mockReturnValue('');

    mockFetchGroq = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"trigger_pattern":"価格","instruction":"案内","priority":5,"reason":"改善"}' } }] }),
    });
    global.fetch = mockFetchGroq as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env['GROQ_API_KEY'];
  });

  // 13. deep_research=ON時にリサーチセクションがプロンプトに含まれる
  it('13. callGroq8bSuggest — researchSectionがプロンプトに含まれる', async () => {
    const researchSection = '## 外部リサーチ（最新の市場動向・学術知見）\n最新の消費者心理研究によると...';
    await callGroq8bSuggest('価格は？', 'お答えします', '', '', '', researchSection);

    const body = JSON.parse((mockFetchGroq.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('外部リサーチ');
    expect(body.messages[0].content).toContain('最新の消費者心理研究');
  });

  // 14. deep_research=OFF時にリサーチセクションが含まれない
  it('14. callGroq8bSuggest — researchSection空のとき外部リサーチが含まれない', async () => {
    await callGroq8bSuggest('価格は？', 'お答えします', '', '', '', '');

    const body = JSON.parse((mockFetchGroq.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).not.toContain('外部リサーチ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 15, 18, 19: ギャップ推薦
// ─────────────────────────────────────────────────────────────────────────────
describe('[60C] ナレッジギャップ推薦 — ディープリサーチ注入', () => {
  const GAPS = [{ id: 1, user_question: '返品方法を教えてください' }];
  const GEMINI_RESPONSE = JSON.stringify([
    { index: 1, recommended_action: '返品FAQを追加', suggested_answer: '30日以内に返品可能' },
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchKnowledge.mockResolvedValue({ results: [] });
    mockFormatKnowledge.mockReturnValue('');
    mockGetCrossTenant.mockResolvedValue(EMPTY_CROSS_TENANT);
    mockFormatCrossTenant.mockReturnValue('');
    mockCallGeminiJudge.mockResolvedValue(GEMINI_RESPONSE);
    mockDbQuery
      .mockResolvedValueOnce({ rows: GAPS })
      .mockResolvedValue({ rows: [] });
  });

  // 15. deep_research=ON時にリサーチセクションが含まれる
  it('15. deep_research=ON — Geminiプロンプトに外部リサーチが含まれる', async () => {
    mockIsDeepResearchEnabled.mockResolvedValue(true);
    mockGetResearchProvider.mockReturnValue({ search: mockSearch });
    mockSearch.mockResolvedValue(MOCK_RESEARCH_RESULT);

    await generateRecommendations('tenant-test');

    const calledPrompt: string = mockCallGeminiJudge.mock.calls[0]?.[0] ?? '';
    expect(calledPrompt).toContain('外部リサーチ');
    expect(calledPrompt).toContain('最新の消費者心理研究によると');
  });

  // 18. deep_research=ON時にPerplexity API呼び出しが発生する
  it('18. deep_research=ON → Perplexity API（search）が呼ばれる', async () => {
    mockIsDeepResearchEnabled.mockResolvedValue(true);
    mockGetResearchProvider.mockReturnValue({ search: mockSearch });
    mockSearch.mockResolvedValue(MOCK_RESEARCH_RESULT);

    await generateRecommendations('tenant-test');

    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  // 19. deep_research=OFF時にPerplexity API呼び出しが発生しない
  it('19. deep_research=OFF → Perplexity API（search）が呼ばれない', async () => {
    mockIsDeepResearchEnabled.mockResolvedValue(false);

    await generateRecommendations('tenant-test');

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockGetResearchProvider).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 16: AIアシスタント
// ─────────────────────────────────────────────────────────────────────────────
describe('[60C] 管理画面AIアシスタント — ディープリサーチ注入', () => {
  let mockFetchGroq: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['GROQ_API_KEY'] = 'test-groq-key';
    mockSearchKnowledge.mockResolvedValue({ results: [] });
    mockFormatKnowledge.mockReturnValue('');
    mockGetCrossTenant.mockResolvedValue(EMPTY_CROSS_TENANT);
    mockFormatCrossTenant.mockReturnValue('');
    mockIsDeepResearchEnabled.mockResolvedValue(true);
    mockGetResearchProvider.mockReturnValue({ search: mockSearch });
    mockSearch.mockResolvedValue(MOCK_RESEARCH_RESULT);

    mockFetchGroq = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'business_faq' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '詳細はサポートへ' } }] }),
      });
    global.fetch = mockFetchGroq as unknown as typeof fetch;
    mockDbQuery.mockResolvedValue({ rows: [{ id: 'fb-001' }] });
  });

  afterEach(() => {
    delete process.env['GROQ_API_KEY'];
  });

  // 16. deep_research=ON時にリサーチセクションが含まれる
  it('16. deep_research=ON — Groq 70bのシステムプロンプトに外部リサーチが含まれる', async () => {
    const app = express();
    app.use(express.json());
    registerAdminAiAssistRoutes(app);

    await supertest(app)
      .post('/v1/admin/ai-assist/chat')
      .send({ message: '返品方法を教えてください' });

    expect(mockFetchGroq).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((mockFetchGroq.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(secondBody.messages[0].content).toContain('外部リサーチ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト 17: Judge評価（対象外 — リサーチ注入されない）
// ─────────────────────────────────────────────────────────────────────────────
describe('[60C] Judge評価 — ディープリサーチ注入なし', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('17. Judge評価はdeep_research=ONでも外部リサーチを含まない', async () => {
    // judgeEvaluatorは別モジュールで直接テスト済み
    // Judge は isDeepResearchEnabled / getResearchProvider を import していない
    const judgeSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/agent/judge/judgeEvaluator.ts'),
      'utf-8'
    ) as string;
    expect(judgeSource).not.toContain('isDeepResearchEnabled');
    expect(judgeSource).not.toContain('getResearchProvider');
  });
});
