// src/api/admin/tuning/getTuningRulesFilters.test.ts
// GID 1215916762299598: 判定ルール一覧(AIReportTab)がMOCK_RULESにフォールバックし続けていた
// 不具合の修正 — GET /v1/admin/tuning-rules の source/status クエリパラメータ配線の回帰テスト

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

const mockListRules = jest.fn().mockResolvedValue([]);
jest.mock('./tuningRulesRepository', () => ({
  listRules: (...args: any[]) => mockListRules(...args),
  createRule: jest.fn(),
  updateRule: jest.fn(),
  deleteRule: jest.fn(),
}));
jest.mock('../../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn(),
  formatKnowledgeContext: jest.fn(),
}));
jest.mock('../../../lib/crossTenantContext', () => ({
  getCrossTenantContext: jest.fn(),
  formatCrossTenantContext: jest.fn(),
}));
jest.mock('../../../lib/research', () => ({ getResearchProvider: jest.fn() }));
jest.mock('../../../lib/research/featureCheck', () => ({ isDeepResearchEnabled: jest.fn() }));
jest.mock('../../../lib/research/queryBuilder', () => ({ buildResearchQuery: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { registerTuningRoutes } from './routes';

function makeApp(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata, email: 'test@test.com' } : null;
    next();
  });
  registerTuningRoutes(app);
  return app;
}

describe('GET /v1/admin/tuning-rules — source/status フィルタ配線', () => {
  beforeEach(() => {
    mockListRules.mockClear();
    mockListRules.mockResolvedValue([]);
  });

  it('super_admin: ?tenant=&source=judge&status=pending がlistRulesにそのまま渡る', async () => {
    const res = await request(makeApp({ role: 'super_admin', tenant_id: '' }))
      .get('/v1/admin/tuning-rules?tenant=tenant-abc&source=judge&status=pending');

    expect(res.status).toBe(200);
    expect(mockListRules).toHaveBeenCalledWith('tenant-abc', { source: 'judge', status: 'pending' });
  });

  it('source/statusクエリなし → filtersはundefinedのまま(全件取得の従来挙動を維持)', async () => {
    const res = await request(makeApp({ role: 'super_admin', tenant_id: '' }))
      .get('/v1/admin/tuning-rules');

    expect(res.status).toBe(200);
    expect(mockListRules).toHaveBeenCalledWith(undefined, { source: undefined, status: undefined });
  });

  it('client_admin: tenantクエリは無視されJWT由来のtenant_idが使われる', async () => {
    const res = await request(makeApp({ role: 'client_admin', tenant_id: 'own-tenant' }))
      .get('/v1/admin/tuning-rules?tenant=other-tenant&source=judge&status=pending');

    expect(res.status).toBe(200);
    expect(mockListRules).toHaveBeenCalledWith('own-tenant', { source: 'judge', status: 'pending' });
  });

  it('レスポンスは {rules, total} 形式でlistRulesの結果をそのまま返す', async () => {
    mockListRules.mockResolvedValueOnce([{ id: 1, trigger_pattern: 'x', expected_behavior: 'y' }]);

    const res = await request(makeApp({ role: 'super_admin', tenant_id: '' }))
      .get('/v1/admin/tuning-rules?source=judge&status=pending');

    expect(res.body).toEqual({
      rules: [{ id: 1, trigger_pattern: 'x', expected_behavior: 'y' }],
      total: 1,
    });
  });
});
