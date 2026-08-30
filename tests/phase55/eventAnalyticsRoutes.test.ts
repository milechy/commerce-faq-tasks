// tests/phase55/eventAnalyticsRoutes.test.ts
// Phase55: GET /v1/admin/analytics/events テスト

import express from 'express';
import { request } from "../helpers/testServer";
import { registerEventAnalyticsRoutes } from '../../src/api/admin/analytics/eventAnalyticsRoutes';

// supabaseAuthMiddleware をモック
jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    // テストケースごとに req._mockUser を参照
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

// pool をモック
jest.mock('../../src/lib/db', () => ({
  pool: null, // デフォルトは null、テストごとに上書き
}));

import { pool as poolModule } from '../../src/lib/db';

function makeApp(opts: {
  role?: 'super_admin' | 'client_admin';
  tenantId?: string;
  dbRows?: object[];
  dbError?: Error;
  dbNull?: boolean;
  // [H-7] planゲート追加により、client_adminはqueryTenantPlanの結果で403になり得る。
  // このテストファイルの本来の関心事(role/tenant/period/group_by等)を検証し続けられるよう、
  // 既定でゲートを通過できるplanを返す(super_adminはバイパスされるため影響しない)。
  plan?: string;
}) {
  const { role = 'client_admin', tenantId = 'tenant-a', dbRows = [], dbError, plan = 'growth' } = opts;

  const app = express();
  app.use(express.json());

  // supabaseUser を req に注入するミドルウェア
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = {
      app_metadata: { role, tenant_id: tenantId },
    };
    next();
  });

  // pool モックを差し替え
  const mockPool: any = opts.dbNull
    ? null
    : {
        query: jest.fn().mockImplementation((sql: string) => {
          if (dbError) return Promise.reject(dbError);
          // [H-7] queryTenantPlan(`SELECT plan FROM tenants ...`)は行動イベント本体の
          // クエリ(behavioral_events)とは別物なので、SQLで判別して答える。
          if (/SELECT\s+plan\s+FROM\s+tenants/i.test(sql)) {
            return Promise.resolve({ rows: [{ plan }] });
          }
          return Promise.resolve({ rows: dbRows });
        }),
      };

  // pool モジュールの参照を差し替え
  (poolModule as any); // 参照確認
  jest.replaceProperty(require('../../src/lib/db'), 'pool', mockPool);

  registerEventAnalyticsRoutes(app);
  return { app, mockPool };
}

describe('GET /v1/admin/analytics/events', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Super Admin', () => {
    it('全テナントのイベント取得 → 200 + tenant_id=null', async () => {
      const { app, mockPool } = makeApp({
        role: 'super_admin',
        dbRows: [
          { group_key: 'page_view', date: '2026-04-01', count: '10' },
          { group_key: 'chat_open', date: '2026-04-01', count: '5' },
        ],
      });

      const res = await request(app).get('/v1/admin/analytics/events');

      expect(res.status).toBe(200);
      expect(res.body.tenant_id).toBeNull();
      expect(res.body.period).toBe('7d');
      expect(res.body.group_by).toBe('event_type');
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('?tenant_id=tenant-b → その tenant のデータのみ', async () => {
      const { app, mockPool } = makeApp({
        role: 'super_admin',
        dbRows: [{ group_key: 'scroll_depth', date: '2026-04-01', count: '3' }],
      });

      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ tenant_id: 'tenant-b' });

      expect(res.status).toBe(200);
      expect(res.body.tenant_id).toBe('tenant-b');
    });
  });

  describe('Client Admin', () => {
    it('自テナント → 200', async () => {
      const { app } = makeApp({
        role: 'client_admin',
        tenantId: 'tenant-a',
        dbRows: [{ group_key: 'page_view', date: '2026-04-01', count: '7' }],
      });

      const res = await request(app).get('/v1/admin/analytics/events');

      expect(res.status).toBe(200);
      expect(res.body.tenant_id).toBe('tenant-a');
    });

    it('他テナント指定 → 403', async () => {
      const { app } = makeApp({
        role: 'client_admin',
        tenantId: 'tenant-a',
      });

      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ tenant_id: 'tenant-b' });

      expect(res.status).toBe(403);
    });

    it('自テナントを明示的に指定 → 200 (許可)', async () => {
      const { app } = makeApp({
        role: 'client_admin',
        tenantId: 'tenant-a',
        dbRows: [],
      });

      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ tenant_id: 'tenant-a' });

      expect(res.status).toBe(200);
    });
  });

  // [H-7] GID 1217969364194602: 行動イベント分析は「基本の会話分析」(analytics)の一部として
  // Standard〜で開放する。plan=starter未満は403、standard以上は通過することの回帰テスト。
  describe('plan ゲート', () => {
    it('client_admin + plan=starter → 403 plan_upgrade_required', async () => {
      const { app, mockPool } = makeApp({
        role: 'client_admin',
        tenantId: 'tenant-a',
        plan: 'starter',
      });

      const res = await request(app).get('/v1/admin/analytics/events');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('plan_upgrade_required');
      expect(mockPool.query).toHaveBeenCalledTimes(1); // plan確認のみ、行動イベントのクエリは実行されない
    });

    it('client_admin + plan=standard → 200 (ゲートを通過する)', async () => {
      const { app } = makeApp({
        role: 'client_admin',
        tenantId: 'tenant-a',
        plan: 'standard',
        dbRows: [],
      });

      const res = await request(app).get('/v1/admin/analytics/events');

      expect(res.status).toBe(200);
    });

    it('super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)', async () => {
      const { app, mockPool } = makeApp({ role: 'super_admin', dbRows: [] });

      const res = await request(app).get('/v1/admin/analytics/events');

      expect(res.status).toBe(200);
      const firstCallSql = mockPool.query.mock.calls[0]?.[0] ?? '';
      expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
    });
  });

  describe('period パラメータ', () => {
    it('period=7d → 200', async () => {
      const { app } = makeApp({ role: 'super_admin', dbRows: [] });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ period: '7d' });
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('7d');
    });

    it('period=30d → 200', async () => {
      const { app } = makeApp({ role: 'super_admin', dbRows: [] });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ period: '30d' });
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('30d');
    });

    it('period=1d → 200', async () => {
      const { app } = makeApp({ role: 'super_admin', dbRows: [] });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ period: '1d' });
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('1d');
    });

    it('period=90d → 200', async () => {
      const { app } = makeApp({ role: 'super_admin', dbRows: [] });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ period: '90d' });
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('90d');
    });

    it('period 不明 → デフォルト 7d', async () => {
      const { app } = makeApp({ role: 'super_admin', dbRows: [] });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ period: 'invalid' });
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('invalid'); // period は返すがdays=7で処理
    });
  });

  describe('group_by パラメータ', () => {
    it('group_by=event_type → イベントタイプ別集計 200', async () => {
      const { app } = makeApp({
        role: 'super_admin',
        dbRows: [
          { group_key: 'page_view', date: '2026-04-01', count: '10' },
          { group_key: 'page_view', date: '2026-03-31', count: '8' },
          { group_key: 'chat_open', date: '2026-04-01', count: '3' },
        ],
      });

      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ group_by: 'event_type' });

      expect(res.status).toBe(200);
      expect(res.body.group_by).toBe('event_type');
      const pageView = res.body.events.find((e: any) => e.event_type === 'page_view');
      expect(pageView).toBeDefined();
      expect(pageView.total).toBe(18);
    });

    it('group_by=page_url → 200', async () => {
      const { app } = makeApp({ role: 'super_admin', dbRows: [] });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ group_by: 'page_url' });
      expect(res.status).toBe(200);
      expect(res.body.group_by).toBe('page_url');
    });

    it('group_by=visitor_id → 200', async () => {
      const { app } = makeApp({ role: 'super_admin', dbRows: [] });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ group_by: 'visitor_id' });
      expect(res.status).toBe(200);
    });

    it('group_by=invalid → 400', async () => {
      const { app } = makeApp({ role: 'super_admin' });
      const res = await request(app)
        .get('/v1/admin/analytics/events')
        .query({ group_by: 'DROP TABLE users--' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_group_by');
    });
  });

  describe('レスポンス構造', () => {
    it('events 配列の各要素が group_by / daily / total を持つ', async () => {
      const { app } = makeApp({
        role: 'super_admin',
        dbRows: [
          { group_key: 'chat_open', date: '2026-04-01', count: '5' },
          { group_key: 'chat_open', date: '2026-03-31', count: '3' },
        ],
      });

      const res = await request(app).get('/v1/admin/analytics/events');

      expect(res.status).toBe(200);
      const ev = res.body.events[0];
      expect(ev).toHaveProperty('event_type');
      expect(ev).toHaveProperty('daily');
      expect(ev).toHaveProperty('total', 8);
      expect(Array.isArray(ev.daily)).toBe(true);
      expect(ev.daily[0]).toHaveProperty('date');
      expect(ev.daily[0]).toHaveProperty('count');
    });

    it('daily は date 降順', async () => {
      const { app } = makeApp({
        role: 'super_admin',
        dbRows: [
          { group_key: 'page_view', date: '2026-03-30', count: '1' },
          { group_key: 'page_view', date: '2026-04-01', count: '5' },
          { group_key: 'page_view', date: '2026-03-31', count: '3' },
        ],
      });

      const res = await request(app).get('/v1/admin/analytics/events');

      expect(res.status).toBe(200);
      const daily = res.body.events[0].daily;
      expect(daily[0].date).toBe('2026-04-01');
      expect(daily[1].date).toBe('2026-03-31');
      expect(daily[2].date).toBe('2026-03-30');
    });
  });

  describe('DB エラー', () => {
    it('DB null → 503', async () => {
      const { app } = makeApp({ role: 'super_admin', dbNull: true });
      const res = await request(app).get('/v1/admin/analytics/events');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('database_unavailable');
    });

    it('DB クエリエラー → 500', async () => {
      const { app } = makeApp({
        role: 'super_admin',
        dbError: new Error('connection refused'),
      });
      const res = await request(app).get('/v1/admin/analytics/events');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal_error');
    });
  });
});
