// src/api/admin/analytics/flowTransitions.test.ts
// Phase72-C: GET /v1/admin/analytics/flow-transitions テスト

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

jest.mock('../../../lib/crypto/textEncrypt', () => ({
  decryptText: jest.fn((v: string) => v),
}));

// supabase auth middleware — x-role / x-tenant-id ヘッダで制御
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/analytics/flow-transitions', () => {
  beforeEach(() => mockQuery.mockClear());

  it('正常系: super_admin がデータを取得できる', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { from_state: 'clarify', to_state: 'answer', transition_count: 120 },
          { from_state: 'answer', to_state: 'confirm', transition_count: 80 },
          { from_state: 'confirm', to_state: 'terminal', transition_count: 60 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ cnt: 45 }] }); // completed count

    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/flow-transitions?period=30d')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      period: '30d',
      total_transitions: 260,
      funnel: expect.objectContaining({
        to_confirm_count: 80,
        to_terminal_count: 60,
        completed_count: 45,
      }),
      transitions: expect.arrayContaining([
        expect.objectContaining({ from_state: 'clarify', to_state: 'answer', transition_count: 120 }),
      ]),
    });
  });

  it('403: client_admin はアクセス拒否される', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/flow-transitions')
      .set('x-role', 'client_admin');

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('code', 'AUTH_ROLE_INSUFFICIENT');
  });

  it('403: 無効なロールはアクセス拒否される', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/flow-transitions')
      .set('x-role', 'unknown_role');

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('code', 'AUTH_ROLE_INVALID');
  });

  it('ゼロ行のとき率は 0% でNaN/nullにならない', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })          // transitions: no data
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] }); // completed: 0

    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/flow-transitions?period=7d')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.total_transitions).toBe(0);
    expect(res.body.funnel.confirm_rate_pct).toBe(0);
    expect(res.body.funnel.completion_rate_pct).toBe(0);
    expect(Number.isNaN(res.body.funnel.confirm_rate_pct)).toBe(false);
    expect(Number.isNaN(res.body.funnel.completion_rate_pct)).toBe(false);
  });

  it('period が不正値のとき 30d にフォールバックする', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/flow-transitions?period=999d')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.period).toBe('30d');
  });

  it('tenant_id クエリで super_admin はテナント絞り込みができる', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ from_state: 'clarify', to_state: 'answer', transition_count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 3 }] });

    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/flow-transitions?period=30d&tenant_id=tenant-xyz')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe('tenant-xyz');
  });
});
