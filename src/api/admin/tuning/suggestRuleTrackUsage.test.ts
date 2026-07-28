// src/api/admin/tuning/suggestRuleTrackUsage.test.ts
// GID 1216944003337186: POST /v1/admin/tuning/suggest-rule のtrackUsage計測を検証。
// モック構成はtuningAuthGuard.test.tsに準拠。

jest.mock('../../../lib/db', () => ({
  pool: null,
  getPool: () => null,
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('./tuningRulesRepository', () => ({
  listRules: jest.fn().mockResolvedValue([]),
  createRule: jest.fn().mockResolvedValue({ id: 1 }),
  updateRule: jest.fn().mockResolvedValue({ id: 1 }),
  deleteRule: jest.fn().mockResolvedValue({ id: 1 }),
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
import { registerTuningRoutes } from './routes';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeApp(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata
      ? { app_metadata: appMetadata, email: 'test@test.com' }
      : null;
    next();
  });
  registerTuningRoutes(app);
  return app;
}

const GROQ_SUGGEST_BODY = {
  choices: [{ message: { content: JSON.stringify({
    trigger_pattern: '価格について聞かれた場合',
    instruction: '料金プランの詳細を案内する',
    priority: 5,
    reason: '価格への関心が高いため',
  }) } }],
};

describe('POST /v1/admin/tuning/suggest-rule — trackUsage計測', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-groq-key';
    mockTrackUsage.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
  });

  it('正常系: trackUsage(admin_tuning)を1回記録する', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GROQ_SUGGEST_BODY });

    const res = await request(makeApp({ role: 'client_admin', tenant_id: 'tenant-a' }))
      .post('/v1/admin/tuning/suggest-rule')
      .send({ userMessage: '料金を教えて', aiMessage: 'プランをご案内します' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', featureUsed: 'admin_tuning' })
    );
  });

  it('権限なし（viewer等）は403でtrackUsageを呼ばない', async () => {
    const res = await request(makeApp({ role: 'viewer', tenant_id: 'tenant-a' }))
      .post('/v1/admin/tuning/suggest-rule')
      .send({ userMessage: '料金を教えて', aiMessage: 'プランをご案内します' });

    expect(res.status).toBe(403);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('バリデーションエラー時はtrackUsageを呼ばない', async () => {
    const res = await request(makeApp({ role: 'client_admin', tenant_id: 'tenant-a' }))
      .post('/v1/admin/tuning/suggest-rule')
      .send({});

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
