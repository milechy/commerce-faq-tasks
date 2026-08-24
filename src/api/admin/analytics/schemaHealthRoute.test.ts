// src/api/admin/analytics/schemaHealthRoute.test.ts
// GET /v1/admin/analytics/measurement-health に合流させた **super_admin 限定の運用ペイロード**
// (スキーマ整合 / 点火状態)の HTTP 層テスト。
// 判定ロジックは schemaHealth.test.ts / ignitionStatus.test.ts で純関数として検証済みなので、
// ここでは「R2C運用にだけ出す」ことと「新エンドポイントを作っていない」ことだけを固定する。

import express from 'express';
import request from 'supertest';

const mockFetchMeasurementHealth = jest.fn();
const mockFetchSchemaHealth = jest.fn();
const mockFetchIgnitionStatus = jest.fn();

jest.mock('./measurementHealth', () => ({
  fetchMeasurementHealth: (...args: unknown[]) => mockFetchMeasurementHealth(...args),
}));
jest.mock('./schemaHealth', () => ({
  fetchSchemaHealth: (...args: unknown[]) => mockFetchSchemaHealth(...args),
}));
jest.mock('./ignitionStatus', () => ({
  fetchIgnitionStatus: (...args: unknown[]) => mockFetchIgnitionStatus(...args),
}));

jest.mock('../../../lib/db', () => ({ pool: {}, getPool: () => ({}) }));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: {
        role: (req.headers['x-role'] as string) ?? 'client_admin',
        tenant_id: (req.headers['x-tenant-id'] as string) ?? 'tenant-A',
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

const BASE_HEALTH = {
  sourceBreakdown: [],
  emptySessionCount: 0,
  cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
  outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
  validUserSessionCount: 0,
};

describe('GET /v1/admin/analytics/measurement-health のスキーマ整合', () => {
  beforeEach(() => {
    mockFetchMeasurementHealth.mockReset().mockResolvedValue(BASE_HEALTH);
    mockFetchSchemaHealth.mockReset().mockResolvedValue({
      missing: [{ table: 'chat_sessions', columns: ['visitor_id'], tableMissing: false }],
      checkedTables: 34,
      checkedColumns: 257,
    });
    mockFetchIgnitionStatus.mockReset().mockResolvedValue({
      rows: [{ tenantId: 'carnation', cells: [] }],
      envControlledFeatures: ['judge_sweep'],
      anyEnabled: false,
    });
  });

  it('super_admin には欠落列を返す', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.schemaHealth.missing).toEqual([
      { table: 'chat_sessions', columns: ['visitor_id'], tableMissing: false },
    ]);
    expect(mockFetchSchemaHealth).toHaveBeenCalledTimes(1);
  });

  it('client_admin には返さない(R2C運用の情報であり、テナントの関心事ではない)', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'client_admin')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.schemaHealth).toBeUndefined();
    expect(res.body.ignitionStatus).toBeUndefined();
    // テナントに対して余計なクエリを投げない
    expect(mockFetchSchemaHealth).not.toHaveBeenCalled();
    expect(mockFetchIgnitionStatus).not.toHaveBeenCalled();
    // 既存の計測ヘルス自体は従来どおり返る
    expect(res.body.validUserSessionCount).toBe(0);
  });

  it('欠落なしのときも missing: [] を返す(「異常なし」を描けるようにする)', async () => {
    mockFetchSchemaHealth.mockResolvedValueOnce({ missing: [], checkedTables: 34, checkedColumns: 257 });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.body.schemaHealth.missing).toEqual([]);
    expect(res.body.schemaHealth.checkedTables).toBe(34);
  });

  it('super_admin には点火状態も返す(env でしか開閉できない機能を含む)', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.ignitionStatus.rows[0].tenantId).toBe('carnation');
    expect(res.body.ignitionStatus.envControlledFeatures).toContain('judge_sweep');
    expect(res.body.ignitionStatus.anyEnabled).toBe(false);
  });
});
