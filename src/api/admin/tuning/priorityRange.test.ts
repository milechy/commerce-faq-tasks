// src/api/admin/tuning/priorityRange.test.ts
// D5: priority の zod 値域を実態(0〜10、admin-ui/src/lib/tuningPriority.ts の3段階表示・
// judgeEvaluator/evaluationAnalyzerの生成値)に揃えた回帰テスト。
// 旧い -100〜100 は実態と無関係な値域で、範囲外値を弾かないまま旧UI(3段階表示)へ渡すと
// low/normal/high のいずれにも丸め切れない見え方をチャットとの間で作っていた(D5)。

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

const mockCreateRule = jest.fn();
const mockUpdateRule = jest.fn();
jest.mock('./tuningRulesRepository', () => ({
  listRules: jest.fn().mockResolvedValue([]),
  createRule: (...args: any[]) => mockCreateRule(...args),
  updateRule: (...args: any[]) => mockUpdateRule(...args),
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
import { request } from "../../../../tests/helpers/testServer";
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

const CLIENT_ADMIN = { role: 'client_admin', tenant_id: 'tenant-abc' };

beforeEach(() => {
  mockCreateRule.mockReset();
  mockUpdateRule.mockReset();
  mockCreateRule.mockResolvedValue({ id: 1, tenant_id: 'tenant-abc', trigger_pattern: 't', expected_behavior: 'e', priority: 5, is_active: true });
  mockUpdateRule.mockResolvedValue({ id: 1, tenant_id: 'tenant-abc', trigger_pattern: 't', expected_behavior: 'e', priority: 5, is_active: true });
});

describe('POST /v1/admin/tuning-rules — priority の値域(0〜10)', () => {
  it.each([-100, -1, 11, 100])('priority=%i(範囲外) は 400 で createRule を呼ばない', async (priority) => {
    const res = await request(makeApp(CLIENT_ADMIN))
      .post('/v1/admin/tuning-rules')
      .send({ tenant_id: 'tenant-abc', trigger_pattern: 'x', expected_behavior: 'y', priority });

    expect(res.status).toBe(400);
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it.each([0, 3, 7, 10])('priority=%i(範囲内) はそのまま createRule に渡る', async (priority) => {
    const res = await request(makeApp(CLIENT_ADMIN))
      .post('/v1/admin/tuning-rules')
      .send({ tenant_id: 'tenant-abc', trigger_pattern: 'x', expected_behavior: 'y', priority });

    expect(res.status).toBe(201);
    expect(mockCreateRule).toHaveBeenCalledWith(expect.objectContaining({ priority }));
  });
});

describe('PUT /v1/admin/tuning-rules/:id — priority の値域(0〜10)', () => {
  it.each([-100, -1, 11, 100])('priority=%i(範囲外) は 400 で updateRule を呼ばない', async (priority) => {
    const res = await request(makeApp(CLIENT_ADMIN))
      .put('/v1/admin/tuning-rules/1')
      .send({ priority });

    expect(res.status).toBe(400);
    expect(mockUpdateRule).not.toHaveBeenCalled();
  });

  it.each([0, 3, 7, 10])('priority=%i(範囲内) はそのまま updateRule に渡る', async (priority) => {
    const res = await request(makeApp(CLIENT_ADMIN))
      .put('/v1/admin/tuning-rules/1')
      .send({ priority });

    expect(res.status).toBe(200);
    expect(mockUpdateRule).toHaveBeenCalledWith(1, expect.objectContaining({ priority }), 'tenant-abc');
  });
});
