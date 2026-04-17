// src/api/admin/analytics/cvAggregation.test.ts
// Phase65-3: CV指標 (summary拡張 + cv-statusエンドポイント) のユニットテスト

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

/** summary エンドポイントが呼ぶ 9 クエリのデフォルトモック (CV関連含む) */
function mockSummaryQueries({
  cvRows = [] as Array<{ conversion_type: string; count: number; total_value: string }>,
  tenantAgeDays = 30,
} = {}) {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ total_sessions: '0' }] })      // sessions
    .mockResolvedValueOnce({ rows: [{ prev_total_sessions: '0' }] }) // prev sessions
    .mockResolvedValueOnce({ rows: [{ avg_judge_score: null }] })     // judge score
    .mockResolvedValueOnce({ rows: [{ total_knowledge_gaps: '0' }] }) // knowledge gaps
    .mockResolvedValueOnce({ rows: [{ avg_messages_per_session: '0' }] }) // avg msg
    .mockResolvedValueOnce({ rows: [{ avatar_session_count: '0' }] }) // avatar
    .mockResolvedValueOnce({ rows: [] })                              // sentiment
    .mockResolvedValueOnce({ rows: cvRows })                          // CV aggregation
    .mockResolvedValueOnce({ rows: [{ days: tenantAgeDays }] });      // tenant age
}

// ---------------------------------------------------------------------------
// cv-status エンドポイント (ケース1-4, 5-6)
// ---------------------------------------------------------------------------

describe('GET /v1/admin/analytics/cv-status', () => {
  beforeEach(() => mockQuery.mockClear());

  // ケース1: CV=0件のテナントは cv_fired_status='not_fired'
  it('ケース1: CV=0のテナントは not_fired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', tenant_name: 'テナント1', cv_count_30d: 0, last_cv_at: null, days_since_effective_start: 10 },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/cv-status')
      .set('x-role', 'super_admin');
    expect(res.status).toBe(200);
    expect(res.body.tenants[0].cv_fired_status).toBe('not_fired');
    expect(res.body.not_fired_tenants).toBe(1);
  });

  // ケース2: CV>=1件のテナントは cv_fired_status='fired'
  it('ケース2: CV>=1のテナントは fired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', tenant_name: 'テナント1', cv_count_30d: 3, last_cv_at: new Date('2026-04-17'), days_since_effective_start: 20 },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/cv-status')
      .set('x-role', 'super_admin');
    expect(res.status).toBe(200);
    expect(res.body.tenants[0].cv_fired_status).toBe('fired');
    expect(res.body.fired_tenants).toBe(1);
  });

  // ケース3: 30日より古いCVは集計対象外 — SQLに 'INTERVAL '30 days'' が含まれること
  it('ケース3: クエリに30日フィルタが含まれる', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    await request(app)
      .get('/v1/admin/analytics/cv-status')
      .set('x-role', 'super_admin');
    const sql: string = mockQuery.mock.calls[0][0];
    expect(sql).toContain("INTERVAL '30 days'");
  });

  // ケース4: conversion_value の合計が正しく計算される (summaryから確認)
  it('ケース4: summary の cv_total_value_30d が SUM を正しく反映する', async () => {
    mockSummaryQueries({
      cvRows: [
        { conversion_type: 'purchase', count: 1, total_value: '2890000' },
        { conversion_type: 'inquiry', count: 2, total_value: '0' },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/summary?period=30d')
      .set('x-role', 'client_admin')
      .set('x-tenant-id', 'tenant-1');
    expect(res.status).toBe(200);
    expect(res.body.cv_count_30d).toBe(3);
    expect(res.body.cv_total_value_30d).toBe(2890000);
    expect(res.body.cv_types_breakdown.purchase).toBe(1);
    expect(res.body.cv_types_breakdown.inquiry).toBe(2);
  });

  // ケース5: super_admin が cv-status で全テナント取得できる
  it('ケース5: super_admin は全テナントの cv-status を取得できる', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', tenant_name: 'A', cv_count_30d: 5, last_cv_at: null, days_since_effective_start: 30 },
        { tenant_id: 't2', tenant_name: 'B', cv_count_30d: 0, last_cv_at: null, days_since_effective_start: 14 },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/cv-status')
      .set('x-role', 'super_admin');
    expect(res.status).toBe(200);
    expect(res.body.total_tenants).toBe(2);
    expect(res.body.fired_tenants).toBe(1);
    expect(res.body.not_fired_tenants).toBe(1);
  });

  // ケース7: chat_sessions なし → days_since_effective_start = tenant作成日からの日数 (フォールバック)
  it('ケース7: chat_sessionsなしの場合 tenant作成日フォールバック', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', tenant_name: 'A', cv_count_30d: 0, last_cv_at: null, days_since_effective_start: 90 },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/cv-status')
      .set('x-role', 'super_admin');
    expect(res.status).toBe(200);
    expect(res.body.tenants[0].days_since_effective_start).toBe(90);
    // SQLにCOALESCEとfirst_session_atが含まれる (フォールバック実装の確認)
    const sql: string = mockQuery.mock.calls[0][0];
    expect(sql).toContain('COALESCE');
    expect(sql).toContain('first_session_at');
  });

  // ケース8: chat_sessions あり → first_session_at 基準の日数が返る
  it('ケース8: 最初のセッションからの日数が返る', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', tenant_name: 'A', cv_count_30d: 0, last_cv_at: null, days_since_effective_start: 3 },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/cv-status')
      .set('x-role', 'super_admin');
    expect(res.status).toBe(200);
    expect(res.body.tenants[0].days_since_effective_start).toBe(3);
  });

  // ケース9: grace period — tenant作成90日前・最初のセッション3日前 → days=3 → grace期間内 (summary)
  it('ケース9: 搭載直後(セッション3日)はsummaryのdays_since_first_session=3を返す', async () => {
    mockSummaryQueries({ tenantAgeDays: 3 }); // first session 3 days ago
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/summary?period=30d')
      .set('x-role', 'client_admin')
      .set('x-tenant-id', 'tenant-1');
    expect(res.status).toBe(200);
    expect(res.body.cv_days_since_first_session).toBe(3);
    // grace period 7日未満 → フロントでアラート非表示にできる
    expect(res.body.cv_days_since_first_session).toBeLessThan(7);
  });

  // ケース6: client_admin は cv-status で 403
  it('ケース6: client_admin が cv-status を叩くと 403', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/analytics/cv-status')
      .set('x-role', 'client_admin')
      .set('x-tenant-id', 'tenant-1');
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
