// src/api/admin/analytics/flowTransitions.test.ts
// Phase72-C: flow-transitions エンドポイント 正常系/認証/0行0% テスト
// avatarSettingsSummary.test.ts の mock パターンを踏襲

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// DB モック（jest.mock で pool を差し替え）
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

// supabase auth middleware — x-role / x-tenant-id ヘッダで制御
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    const role = (req.headers['x-role'] as string) ?? 'super_admin';
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    req.supabaseUser = {
      app_metadata: {
        role,
        ...(tenantId ? { tenant_id: tenantId } : {}),
      },
    };
    next();
  },
}));

import { registerAnalyticsRoutes } from './routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAnalyticsRoutes(app);
  return app;
}

const ROUTE = '/v1/admin/analytics/flow-transitions';

beforeEach(() => {
  mockQuery.mockClear();
});

// ---------------------------------------------------------------------------
// 認証ガード
// ---------------------------------------------------------------------------

describe('GET /v1/admin/analytics/flow-transitions — 認証ガード', () => {
  it('viewer ロール → 403 AUTH_ROLE_INVALID', async () => {
    const app = makeApp();
    const res = await request(app).get(ROUTE).set('x-role', 'viewer').set('x-tenant-id', 'tenant-a');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AUTH_ROLE_INVALID' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('client_admin + tenant_id 無し → 403 AUTH_TENANT_INVALID', async () => {
    const app = makeApp();
    const res = await request(app).get(ROUTE).set('x-role', 'client_admin');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AUTH_TENANT_INVALID' });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

/**
 * flow-transitions が呼ぶ 4 クエリのデフォルトモック:
 * 1. total_sessions
 * 2. transitions (from/to/count)
 * 3. funnel (to_state / reached_sessions)
 * 4. loop_abort count
 */
function mockFlowTransitionQueries({
  totalSessions = 100,
  transitions = [
    { from_state: 'clarify', to_state: 'answer', count: 80 },
    { from_state: 'answer', to_state: 'confirm', count: 60 },
  ],
  funnel = [
    { to_state: 'clarify', reached_sessions: 95 },
    { to_state: 'answer', reached_sessions: 80 },
    { to_state: 'confirm', reached_sessions: 60 },
    { to_state: 'terminal', reached_sessions: 50 },
  ],
  loopAbortCount = 5,
} = {}) {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ total_sessions: String(totalSessions) }] })
    .mockResolvedValueOnce({ rows: transitions })
    .mockResolvedValueOnce({ rows: funnel })
    .mockResolvedValueOnce({ rows: [{ cnt: String(loopAbortCount) }] });
}

describe('GET /v1/admin/analytics/flow-transitions — 正常系', () => {
  it('ケース1: super_admin は 200 かつ全フィールドを受け取れる', async () => {
    mockFlowTransitionQueries();
    const app = makeApp();
    const res = await request(app).get(`${ROUTE}?period=30d`).set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      period: '30d',
      total_sessions: 100,
    });
    expect(Array.isArray(res.body.transitions)).toBe(true);
    expect(res.body.transitions).toHaveLength(2);
    expect(res.body.transitions[0]).toMatchObject({ from_state: 'clarify', to_state: 'answer', count: 80 });
    expect(res.body.funnel).toMatchObject({
      clarify_rate: 0.95,
      answer_rate: 0.8,
      confirm_rate: 0.6,
      terminal_rate: 0.5,
      loop_abort_rate: 0.05,
    });
  });

  it('ケース2: 0 行の場合は rate が 0 で divide-by-zero しない', async () => {
    mockFlowTransitionQueries({ totalSessions: 0, transitions: [], funnel: [], loopAbortCount: 0 });
    const app = makeApp();
    const res = await request(app).get(`${ROUTE}?period=7d`).set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.total_sessions).toBe(0);
    expect(res.body.funnel.clarify_rate).toBe(0);
    expect(res.body.funnel.answer_rate).toBe(0);
    expect(res.body.funnel.confirm_rate).toBe(0);
    expect(res.body.funnel.terminal_rate).toBe(0);
    expect(res.body.funnel.loop_abort_rate).toBe(0);
    // NaN / Infinity でないことを確認
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('ケース3: client_admin は JWT の tenant_id がクエリ引数に自動適用される', async () => {
    mockFlowTransitionQueries({ totalSessions: 10, transitions: [], funnel: [], loopAbortCount: 0 });
    const app = makeApp();
    const res = await request(app)
      .get(ROUTE)
      .set('x-role', 'client_admin')
      .set('x-tenant-id', 'tenant-b');

    expect(res.status).toBe(200);
    // 1回目のクエリの引数に 'tenant-b' が含まれること（テナントスコープ確認）
    const firstCall = mockQuery.mock.calls[0] as [string, any[]];
    expect(firstCall[1]).toContain('tenant-b');
  });
});
