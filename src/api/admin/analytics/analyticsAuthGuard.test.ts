// src/api/admin/analytics/analyticsAuthGuard.test.ts
// Phase69-1.5: analytics/* ALLOWED_ROLES whitelist + tenant_id fail-closed regression tests
// Codex adversarial-review Round 2 findings: analytics endpoints did not reject
// non-admin roles or client_admin with missing app_metadata.tenant_id.

// GID 1217969364194602 [H-7]: 通常はpool=null固定(role/tenantガードのみ検証する
// このファイルの既存方針)だが、planゲートの回帰テストだけpoolにquery可能な
// モックを差し込みたいので、mockPlanPool経由で切り替え可能にする
// (未設定時はnullのまま=既存テストの挙動を変えない)。
let mockPlanPool: { query: jest.Mock } | null = null;

jest.mock('../../../lib/db', () => ({
  get pool() {
    return mockPlanPool;
  },
  getPool: () => mockPlanPool,
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn(),
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerAnalyticsRoutes } from './routes';
import { registerEventAnalyticsRoutes } from './eventAnalyticsRoutes';

function makeApp(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata } : null;
    next();
  });
  registerAnalyticsRoutes(app);
  registerEventAnalyticsRoutes(app);
  return app;
}

// Routes that enforce both ALLOWED_ROLES and non-super-admin tenant_id presence
const TENANT_SCOPED_ROUTES = [
  '/v1/admin/analytics/summary',
  '/v1/admin/analytics/trends',
  '/v1/admin/analytics/evaluations',
  '/v1/admin/analytics/conversions',
  '/v1/admin/analytics/knowledge-attribution',
  '/v1/admin/analytics/events',
  '/v1/admin/analytics/measurement-health',
];

// All routes including super_admin-only endpoints (cv-status, avatar-settings-summary, flow-transitions)
const ALL_ROUTES = [
  ...TENANT_SCOPED_ROUTES,
  '/v1/admin/analytics/cv-status',
  '/v1/admin/analytics/avatar-settings-summary',
  '/v1/admin/analytics/flow-transitions',
];

beforeEach(() => {
  jest.clearAllMocks();
  mockPlanPool = null; // 既定はpool=null(既存テストの前提を変えない)
});

// ---------------------------------------------------------------------------
// Whitelist: viewer role → 403
// ---------------------------------------------------------------------------
describe('analytics routes — ALLOWED_ROLES whitelist (viewer → 403)', () => {
  ALL_ROUTES.forEach((route) => {
    it(`${route} — viewer → 403`, async () => {
      const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
      const res = await request(app).get(route);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Whitelist: undefined role → 403
// ---------------------------------------------------------------------------
describe('analytics routes — ALLOWED_ROLES whitelist (no role → 403)', () => {
  ALL_ROUTES.forEach((route) => {
    it(`${route} — no role → 403`, async () => {
      const app = makeApp({ tenant_id: 'tenant-a' }); // role absent
      const res = await request(app).get(route);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: client_admin without app_metadata.tenant_id → 403
// cv-status is super_admin-only and rejects client_admin at the isSuperAdmin check,
// so it is excluded from this specific tenant guard scenario.
// ---------------------------------------------------------------------------
describe('analytics routes — tenant_id fail-closed (client_admin + no tenant → 403)', () => {
  TENANT_SCOPED_ROUTES.forEach((route) => {
    it(`${route} — client_admin + no tenant → 403`, async () => {
      const app = makeApp({ role: 'client_admin' }); // tenant_id absent
      const res = await request(app).get(route);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Observability: logger.warn called with structured payload on 403 denials
// ---------------------------------------------------------------------------
describe('analytics routes — logger.warn structured payload on 403 (observability)', () => {
  it('/v1/admin/analytics/summary — viewer → logger.warn with AUTH_ROLE_INVALID', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/analytics/summary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTH_ROLE_INVALID',
        hasAppMetadataRole: true,
        hasUserMetadataRole: false,
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/summary — no role → logger.warn with AUTH_ROLE_INVALID', async () => {
    const app = makeApp({ tenant_id: 'tenant-a' }); // role absent
    await request(app).get('/v1/admin/analytics/summary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTH_ROLE_INVALID',
        hasAppMetadataRole: false,
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/summary — client_admin + no tenant → logger.warn with AUTH_TENANT_INVALID', async () => {
    const app = makeApp({ role: 'client_admin' }); // tenant_id absent
    await request(app).get('/v1/admin/analytics/summary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'tenant_id_missing',
        errorCode: 'AUTH_TENANT_INVALID',
        hasAppMetadataTenantId: false,
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/events — viewer → logger.warn with AUTH_ROLE_INVALID', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/analytics/events');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTH_ROLE_INVALID',
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/events — client_admin + no tenant → logger.warn with AUTH_TENANT_INVALID', async () => {
    const app = makeApp({ role: 'client_admin' }); // tenant_id absent
    await request(app).get('/v1/admin/analytics/events');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'tenant_id_missing',
        errorCode: 'AUTH_TENANT_INVALID',
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/cv-status — client_admin (insufficient role) → logger.warn with AUTH_ROLE_INSUFFICIENT', async () => {
    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/analytics/cv-status');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'insufficient_role',
        errorCode: 'AUTH_ROLE_INSUFFICIENT',
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/avatar-settings-summary — client_admin (insufficient role) → logger.warn with AUTH_ROLE_INSUFFICIENT', async () => {
    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/analytics/avatar-settings-summary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'insufficient_role',
        errorCode: 'AUTH_ROLE_INSUFFICIENT',
      }),
      expect.any(String),
    );
  });

  it('403 response includes errorCode field', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    const res = await request(app).get('/v1/admin/analytics/summary');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AUTH_ROLE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// Allow-path: super_admin passes ALLOWED_ROLES + tenant guards → 503 (pool=null)
// knowledge-attribution without ?tenant_id returns 400 (not 403) for super_admin;
// expect(not.toBe(403)) covers both 503 and 400 outcomes.
// ---------------------------------------------------------------------------
describe('analytics routes — allow-path: super_admin passes ALLOWED_ROLES + tenant guards', () => {
  ALL_ROUTES.forEach((route) => {
    it(`${route} — super_admin → not 403 (auth passes; pool unavailable → 503)`, async () => {
      const app = makeApp({ role: 'super_admin' });
      const res = await request(app).get(route);
      expect(res.status).not.toBe(403);
    });
  });

  it('/v1/admin/analytics/summary — super_admin with ?tenant=tenant-a query scoping → 503', async () => {
    const app = makeApp({ role: 'super_admin' });
    const res = await request(app).get('/v1/admin/analytics/summary?tenant=tenant-a');
    expect(res.status).toBe(503);
  });

  it('/v1/admin/analytics/knowledge-attribution — super_admin with ?tenant_id=tenant-a → 503 (auth + tenant resolved, pool unavailable)', async () => {
    const app = makeApp({ role: 'super_admin' });
    const res = await request(app).get('/v1/admin/analytics/knowledge-attribution?tenant_id=tenant-a');
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Allow-path: client_admin with valid tenant_id passes ALLOWED_ROLES + tenant guards → 503
// cv-status is intentionally excluded: client_admin → 403 AUTH_ROLE_INSUFFICIENT (super_admin only)
// ---------------------------------------------------------------------------
describe('analytics routes — allow-path: client_admin with tenant_id passes ALLOWED_ROLES + tenant guards', () => {
  TENANT_SCOPED_ROUTES.forEach((route) => {
    it(`${route} — client_admin + tenant_id → 503 (auth passes, pool unavailable)`, async () => {
      const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
      const res = await request(app).get(route);
      expect(res.status).toBe(503);
    });
  });

  it('/v1/admin/analytics/events — client_admin + own tenant_id in query → 503 (cross-tenant guard permits own tenant)', async () => {
    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    const res = await request(app).get('/v1/admin/analytics/events?tenant_id=tenant-a');
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// GID 1217969364194602 [H-7]: /v1/admin/analytics/events にplanゲートが一切無かった
// (routes.ts の summary/trends/evaluations と同じ「基本の会話分析」(analytics)の
// 一部なのに、Standard未満でも叩けてしまっていた)。回帰テスト。
// pool可用性チェックの後段でplanを見るため、mockPlanPoolにquery可能なモックを
// 差し込む(このdescribeの中だけ。他のテストはpool=nullのまま)。
// ---------------------------------------------------------------------------
describe('analytics routes — /v1/admin/analytics/events plan ゲート', () => {
  it('client_admin + plan=starter → 403 plan_upgrade_required、以降のクエリは実行されない', async () => {
    const mockQuery = jest.fn().mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });
    mockPlanPool = { query: mockQuery };

    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    const res = await request(app).get('/v1/admin/analytics/events');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('plan_upgrade_required');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('client_admin + plan=standard → planゲートを通過する(403にならない)', async () => {
    const mockQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ plan: 'standard' }] }) // plan確認
      .mockResolvedValue({ rows: [] }); // 以降の集計クエリ用フォールバック
    mockPlanPool = { query: mockQuery };

    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    const res = await request(app).get('/v1/admin/analytics/events');

    expect(res.status).not.toBe(403);
  });

  it('super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)', async () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockPlanPool = { query: mockQuery };

    const app = makeApp({ role: 'super_admin' });
    const res = await request(app).get('/v1/admin/analytics/events');

    expect(res.status).not.toBe(403);
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? '';
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});
