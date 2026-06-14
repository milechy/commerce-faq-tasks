// src/api/admin/analytics/avatarSettingsSummary.test.ts
// Phase72-B: アバター設定利用率集計 (avatar-settings-summary) のユニットテスト

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// DB モック
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn().mockResolvedValue(false),
}));

// supabase auth middleware — x-role ヘッダで制御
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: {
        role: (req.headers['x-role'] as string) ?? 'client_admin',
        tenant_id: (req.headers['x-tenant-id'] as string) ?? 'tenant-1',
      },
    };
    next();
  },
}));

import { registerAnalyticsRoutes } from './routes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAnalyticsRoutes(app);
  return app;
}

/** avatar-settings-summary が呼ぶ 3 クエリのデフォルトモック */
function mockAvatarSummaryQueries({
  summaryRow = {
    total_tenants: '5',
    tenants_with_avatar: '3',
    total_configs: '10',
    idle_prompt_configured_rate: '60.0',
    custom_prompt_rate: '40.0',
    custom_voice_rate: '20.0',
  },
  providerRows = [
    { provider: 'heygen', count: 7 },
    { provider: 'lemonslice', count: 3 },
  ],
  top10Rows = [
    { id: 'agent-001', name: 'Agent A', count: 5 },
    { id: 'agent-002', name: 'Agent B', count: 3 },
  ],
} = {}) {
  mockQuery
    .mockResolvedValueOnce({ rows: [summaryRow] })   // CTE summary
    .mockResolvedValueOnce({ rows: providerRows })   // provider distribution
    .mockResolvedValueOnce({ rows: top10Rows });     // template top10
}

// ---------------------------------------------------------------------------
// テスト: GET /v1/admin/analytics/avatar-settings-summary
// ---------------------------------------------------------------------------

describe('GET /v1/admin/analytics/avatar-settings-summary', () => {
  beforeEach(() => mockQuery.mockClear());

  // ケース1: 正常系 — super_admin は 200 かつ全フィールドが存在する
  it('ケース1: super_admin は 200 かつ全フィールドを受け取れる', async () => {
    mockAvatarSummaryQueries();
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/avatar-settings-summary')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total_tenants: 5,
      tenants_with_avatar: 3,
      idle_prompt_configured_rate: 60,
      custom_prompt_rate: 40,
      custom_voice_rate: 20,
    });
    expect(Array.isArray(res.body.avatar_provider_distribution)).toBe(true);
    expect(res.body.avatar_provider_distribution).toHaveLength(2);
    expect(res.body.avatar_provider_distribution[0]).toMatchObject({ provider: 'heygen', count: 7 });
    expect(Array.isArray(res.body.template_id_top10)).toBe(true);
    expect(res.body.template_id_top10[0]).toMatchObject({ id: 'agent-001', name: 'Agent A', count: 5 });
  });

  // ケース2: 認証エラー — client_admin は 403 AUTH_ROLE_INSUFFICIENT
  it('ケース2: client_admin は 403 AUTH_ROLE_INSUFFICIENT', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/avatar-settings-summary')
      .set('x-role', 'client_admin')
      .set('x-tenant-id', 'tenant-1');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'アクセス権限がありません',
      code: 'AUTH_ROLE_INSUFFICIENT',
    });
    // DB クエリが呼ばれていないことを確認
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ケース3: ゼロ件 — avatar_configs が空のとき rate は null (NaN/Infinity でない)
  it('ケース3: avatar_configs が空のとき rate は null', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          total_tenants: '0',
          tenants_with_avatar: '0',
          total_configs: '0',
          idle_prompt_configured_rate: null,
          custom_prompt_rate: null,
          custom_voice_rate: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })  // provider distribution
      .mockResolvedValueOnce({ rows: [] }); // template top10

    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/avatar-settings-summary')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.idle_prompt_configured_rate).toBeNull();
    expect(res.body.custom_prompt_rate).toBeNull();
    expect(res.body.custom_voice_rate).toBeNull();
    // NaN / Infinity でないことを確認
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
    expect(res.body.avatar_provider_distribution).toEqual([]);
    expect(res.body.template_id_top10).toEqual([]);
  });
});
