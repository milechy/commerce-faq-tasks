// src/api/admin/analytics/ruleEffectRoute.test.ts
// GID 1216978677398163 (PR-14): GET /v1/admin/analytics/rule-effect/:ruleId のHTTP層テスト。
// 統計計算そのものは ruleEffect.test.ts で純関数として検証済みのため、ここでは
// RBAC・越境防止・母数不足時に数値を出さないことのみを確認する。

import express from 'express';
import request from 'supertest';

const mockGetRuleEffect = jest.fn();
jest.mock('./ruleEffect', () => ({
  getRuleEffect: (...args: unknown[]) => mockGetRuleEffect(...args),
}));

jest.mock('../../../lib/db', () => ({
  pool: {},
  getPool: () => ({}),
}));

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

// [H-5] GID 1217969425230400: このルートは成果分析(conversion, Growth〜)のplanゲートを
// 通るようになった。ゲート自体の回帰はanalyticsPlanGate.test.tsで確認済みのため、ここでは
// RBAC・越境防止・母数不足時の挙動の検証に集中できるようqueryTenantPlanをgrowth固定でモックする。
jest.mock('../../../lib/billing/planFeatures', () => ({
  ...jest.requireActual('../../../lib/billing/planFeatures'),
  queryTenantPlan: jest.fn().mockResolvedValue('growth'),
}));

import { registerAnalyticsRoutes } from './routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAnalyticsRoutes(app);
  return app;
}

describe('GET /v1/admin/analytics/rule-effect/:ruleId', () => {
  beforeEach(() => mockGetRuleEffect.mockClear());

  it('未承認ルールは数値を出さず not_yet_approved を返す', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'not_yet_approved',
      ruleId: 42,
      tenantId: 'tenant-A',
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/42')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_yet_approved');
    expect(res.body.comparison).toBeUndefined();
  });

  it('母数不足のときは comparison を含めず到達条件だけを返す', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'insufficient_data',
      ruleId: 42,
      tenantId: 'tenant-A',
      approvedAt: '2026-08-01T00:00:00.000Z',
      minSampleSize: 5,
      progress: [
        { group: 'afterTreatment', currentN: 2, requiredN: 5, etaDays: 10 },
      ],
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/42')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('insufficient_data');
    expect(res.body.comparison).toBeUndefined();
    expect(res.body.progress[0].current_n).toBe(2);
    expect(res.body.progress[0].eta_days).toBe(10);
  });

  it('母数充足のときは DiD 比較を返す', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'ok',
      ruleId: 42,
      tenantId: 'tenant-A',
      approvedAt: '2026-08-01T00:00:00.000Z',
      comparison: {
        minSampleSize: 5,
        groups: {},
        did: { estimate: 5, ci95: [1, 9] },
        naiveTreatmentDelta: 10,
      },
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/42')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.comparison.did.estimate).toBe(5);
  });

  it('母数充足かつ上限内(truncated=false)のときは truncated / analyzed_sessions をそのまま返す', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'ok',
      ruleId: 42,
      tenantId: 'tenant-A',
      approvedAt: '2026-08-01T00:00:00.000Z',
      comparison: {
        minSampleSize: 5,
        groups: {},
        did: { estimate: 5, ci95: [1, 9] },
        naiveTreatmentDelta: 10,
      },
      truncated: false,
      analyzedSessions: 20,
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/42')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.analyzed_sessions).toBe(20);
  });

  it('回帰: 上限超過(truncated=true)のときは無言で握りつぶさず、レスポンスにその旨を出す', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'ok',
      ruleId: 42,
      tenantId: 'tenant-A',
      approvedAt: '2026-08-01T00:00:00.000Z',
      comparison: {
        minSampleSize: 5,
        groups: {},
        did: { estimate: 5, ci95: [1, 9] },
        naiveTreatmentDelta: 10,
      },
      truncated: true,
      analyzedSessions: 5000,
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/42')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.analyzed_sessions).toBe(5000);
  });

  it('insufficient_data でも truncated / analyzed_sessions を返す(母数不足かつ上限超過の両立ケース)', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'insufficient_data',
      ruleId: 42,
      tenantId: 'tenant-A',
      approvedAt: '2026-08-01T00:00:00.000Z',
      minSampleSize: 5,
      progress: [
        { group: 'afterTreatment', currentN: 2, requiredN: 5, etaDays: 10 },
      ],
      truncated: true,
      analyzedSessions: 5000,
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/42')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('insufficient_data');
    expect(res.body.truncated).toBe(true);
    expect(res.body.analyzed_sessions).toBe(5000);
  });

  it('他テナントのルールは404で存在有無を漏らさない(存在確認オラクル防止)', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'ok',
      ruleId: 99,
      tenantId: 'tenant-B',
      approvedAt: '2026-08-01T00:00:00.000Z',
      comparison: { minSampleSize: 5, groups: {}, did: { estimate: 1, ci95: [0, 2] }, naiveTreatmentDelta: 1 },
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/99')
      .set('x-tenant-id', 'tenant-A'); // client_admin, 別テナント

    expect(res.status).toBe(404);
    expect(res.body.comparison).toBeUndefined();
  });

  it('存在しないルールIDは404', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({ status: 'rule_not_found' });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/9999')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(404);
  });

  it('不正な ruleId は400', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/not-a-number')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(400);
    expect(mockGetRuleEffect).not.toHaveBeenCalled();
  });

  it('super_admin は任意テナントのルールを閲覧できる', async () => {
    mockGetRuleEffect.mockResolvedValueOnce({
      status: 'ok',
      ruleId: 99,
      tenantId: 'tenant-B',
      approvedAt: '2026-08-01T00:00:00.000Z',
      comparison: { minSampleSize: 5, groups: {}, did: { estimate: 1, ci95: [0, 2] }, naiveTreatmentDelta: 1 },
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/rule-effect/99')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
