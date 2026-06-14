/**
 * Phase72-D: GET /v1/admin/analytics/metrics-history テスト
 *
 * - 正常系: super_admin + 有効 metric → 200 + series 配列
 * - 403: isAllowedAdminRole 失敗
 * - 403: client_admin（isSuperAdmin = false）
 * - 400: granularity whitelist 外
 * - 503: pool null
 */

// pool と logger を先にモック（jest.mock はホイスティングされる）
jest.mock('../../../lib/db', () => ({
  pool: null,
  getPool: () => null,
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn(),
}));
jest.mock('../../../lib/crypto/textEncrypt', () => ({
  decryptText: (s: string) => s,
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { registerAnalyticsRoutes } from './routes';

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function makeMockPool(rows: unknown[] = []) {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(appMetadata: Record<string, unknown> | null, poolOverride?: unknown) {
  const app = express();
  app.use(express.json());

  // Inject mock user
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata } : null;
    next();
  });

  // Override pool via module-level mock after construction
  registerAnalyticsRoutes(app);

  // Attach pool to app.locals so the route can access it if needed
  if (poolOverride) {
    (app as any)._testPool = poolOverride;
  }

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SUPER_ADMIN_META = { role: 'super_admin', tenant_id: null };
const CLIENT_ADMIN_META = { role: 'client_admin', tenant_id: 'tenant-A' };
const VIEWER_META = { role: 'viewer', tenant_id: 'tenant-A' };

describe('GET /v1/admin/analytics/metrics-history', () => {
  let dbModule: { pool: unknown };

  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dbModule = require('../../../lib/db') as { pool: unknown };
  });

  afterEach(() => {
    // pool を null に戻す
    dbModule.pool = null;
  });

  it('super_admin + 有効 metric → 200 + series 配列', async () => {
    const mockRows = [
      { timestamp: new Date('2026-06-14T10:00:00Z'), value: 5, labels: { reason: 'completed' } },
    ];
    dbModule.pool = makeMockPool(mockRows);

    const app = makeApp(SUPER_ADMIN_META);
    const res = await request(app)
      .get('/v1/admin/analytics/metrics-history')
      .query({ metric: 'rajiuce_conversation_terminal_total', period: '7d', granularity: '1h' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('metric', 'rajiuce_conversation_terminal_total');
    expect(res.body).toHaveProperty('period', '7d');
    expect(res.body).toHaveProperty('granularity', '1h');
    expect(Array.isArray(res.body.series)).toBe(true);
    expect(res.body.series).toHaveLength(1);
    expect(res.body.series[0]).toHaveProperty('value', 5);
  });

  it('空データの場合 series = []', async () => {
    dbModule.pool = makeMockPool([]);

    const app = makeApp(SUPER_ADMIN_META);
    const res = await request(app)
      .get('/v1/admin/analytics/metrics-history')
      .query({ metric: 'rajiuce_avatar_requests_total' });

    expect(res.status).toBe(200);
    expect(res.body.series).toEqual([]);
  });

  it('viewer ロール → 403', async () => {
    dbModule.pool = makeMockPool();

    const app = makeApp(VIEWER_META);
    const res = await request(app)
      .get('/v1/admin/analytics/metrics-history')
      .query({ metric: 'rajiuce_loop_detected_total' });

    expect(res.status).toBe(403);
  });

  it('client_admin（non super_admin）→ 403', async () => {
    dbModule.pool = makeMockPool();

    const app = makeApp(CLIENT_ADMIN_META);
    const res = await request(app)
      .get('/v1/admin/analytics/metrics-history')
      .query({ metric: 'rajiuce_conversation_terminal_total' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_ROLE_INSUFFICIENT');
  });

  it('granularity が whitelist 外 → 400', async () => {
    dbModule.pool = makeMockPool();

    const app = makeApp(SUPER_ADMIN_META);
    const res = await request(app)
      .get('/v1/admin/analytics/metrics-history')
      .query({ metric: 'rajiuce_rag_duration_ms', granularity: '2h' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/granularity/);
  });

  it('metric が未指定 → 400', async () => {
    dbModule.pool = makeMockPool();

    const app = makeApp(SUPER_ADMIN_META);
    const res = await request(app)
      .get('/v1/admin/analytics/metrics-history');

    expect(res.status).toBe(400);
  });

  it('pool が null → 503', async () => {
    // dbModule.pool は null のまま
    const app = makeApp(SUPER_ADMIN_META);
    const res = await request(app)
      .get('/v1/admin/analytics/metrics-history')
      .query({ metric: 'rajiuce_conversation_terminal_total' });

    expect(res.status).toBe(503);
  });
});
