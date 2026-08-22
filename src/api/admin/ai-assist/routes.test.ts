// src/api/admin/ai-assist/routes.test.ts
// GID 1216944003337186: POST /v1/admin/ai-assist/chat のtrackUsage計測を検証。
// admin_guideモード（detectIntent + callGroq8b）とbusiness_faqモード（detectIntent + callGroq70b）
// のそれぞれでtrackUsage(featureUsed='admin_ai_assist')が記録されることを確認する。

jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [{ id: 'fb-1' }] }) }),
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn().mockResolvedValue({ results: [] }),
  formatKnowledgeContext: jest.fn().mockReturnValue(''),
}));
jest.mock('../../../lib/crossTenantContext', () => ({
  getCrossTenantContext: jest.fn().mockResolvedValue({
    avgScores: null,
    topPsychologyPrinciples: [],
    commonGapPatterns: [],
    effectiveRulePatterns: [],
    totalTenants: 0,
    dataAsOf: new Date().toISOString(),
  }),
  formatCrossTenantContext: jest.fn().mockReturnValue(''),
}));
jest.mock('../../../lib/research', () => ({
  getResearchProvider: jest.fn().mockReturnValue(null),
}));
jest.mock('../../../lib/research/featureCheck', () => ({
  isDeepResearchEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../lib/research/queryBuilder', () => ({
  buildResearchQuery: jest.fn().mockReturnValue(''),
}));

const mockTrackUsage = jest.fn();
jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

import express from 'express';
import request from 'supertest';
import { registerAdminAiAssistRoutes } from './routes';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** tenantId: null は「未認証」、'' は「認証済みだがテナント未特定（super_admin想定）」 */
function makeApp(tenantId: string | null = 'tenant-a') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser =
      tenantId === null
        ? null
        : {
            app_metadata: {
              tenant_id: tenantId || undefined,
              role: tenantId ? 'client_admin' : 'super_admin',
            },
            email: 'test@test.com',
          };
    next();
  });
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser;
    next();
  });
  registerAdminAiAssistRoutes(app);
  return app;
}

function groqBody(content: string, usage = { prompt_tokens: 50, completion_tokens: 20 }) {
  return { choices: [{ message: { content } }], usage };
}

describe('POST /v1/admin/ai-assist/chat — trackUsage計測', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.GROQ_API_KEY = 'test-groq-key';
    mockTrackUsage.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('admin_guideモード: intent判定 + 回答生成で計2回trackUsage(admin_ai_assist)が記録される', async () => {
    // 1回目: detectIntent（admin_guideのまま） / 2回目: callGroq8b
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => groqBody('admin_guide', { prompt_tokens: 10, completion_tokens: 5 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => groqBody('管理画面の使い方はこちらです', { prompt_tokens: 40, completion_tokens: 15 }) });

    const res = await request(makeApp('tenant-a'))
      .post('/v1/admin/ai-assist/chat')
      .send({ message: 'FAQの登録方法は？' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledTimes(2);
    for (const call of mockTrackUsage.mock.calls) {
      expect(call[0]).toMatchObject({ tenantId: 'tenant-a', featureUsed: 'admin_ai_assist' });
    }
  });

  it('business_faqモード: intent判定 + RAG回答生成で計2回trackUsage(admin_ai_assist)が記録される', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => groqBody('business_faq', { prompt_tokens: 10, completion_tokens: 5 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => groqBody('営業時間は10時〜19時です', { prompt_tokens: 60, completion_tokens: 25 }) });

    const res = await request(makeApp('tenant-a'))
      .post('/v1/admin/ai-assist/chat')
      .send({ message: '営業時間は？' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledTimes(2);
  });

  it('tenantIdなし（super_adminでテナント未特定）はtrackUsageを呼ばない', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => groqBody('管理画面の使い方はこちらです') });

    const res = await request(makeApp(''))
      .post('/v1/admin/ai-assist/chat')
      .send({ message: 'FAQの登録方法は？' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('認証なしは403でtrackUsageを呼ばない', async () => {
    const res = await request(makeApp(null))
      .post('/v1/admin/ai-assist/chat')
      .send({ message: 'FAQの登録方法は？' });

    expect(res.status).toBe(403);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
