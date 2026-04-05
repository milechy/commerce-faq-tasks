// tests/phase56/engagementRoutes.test.ts
// Phase56: engagement CRUD API + Widget向けAPI テスト

import express from 'express';
import request from 'supertest';
import { registerEngagementRoutes } from '../../src/api/engagement/engagementRoutes';

// supabaseAuthMiddleware をモック (req.supabaseUser を注入する形で実装)
jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    // テストケースごとに req._mockRole / req._mockTenantId を参照
    const role = req._mockRole ?? 'super_admin';
    const tenantId = req._mockTenantId ?? 'tenant-a';
    req.supabaseUser = {
      app_metadata: { role, tenant_id: tenantId },
    };
    next();
  },
}));

type Role = 'super_admin' | 'client_admin';

function makeApp(opts: {
  role?: Role;
  tenantId?: string;
  rows?: any[];
  rowCount?: number;
  dbError?: Error;
  dbNull?: boolean;
  // for sequential query mocking
  queryResponses?: Array<{ rows?: any[]; rowCount?: number } | Error>;
}) {
  const {
    role = 'super_admin',
    tenantId = 'tenant-a',
    rows = [],
    rowCount = 1,
    dbError,
    queryResponses,
  } = opts;

  const app = express();
  app.use(express.json());

  // inject mock role/tenantId for supabaseAuthMiddleware mock to pick up
  app.use((req: any, _res: any, next: any) => {
    req._mockRole = role;
    req._mockTenantId = tenantId;
    next();
  });

  let callCount = 0;
  const mockDb: any = opts.dbNull
    ? null
    : {
        query: jest.fn().mockImplementation(() => {
          if (queryResponses) {
            const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
            if (resp instanceof Error) return Promise.reject(resp);
            return Promise.resolve(resp);
          }
          if (dbError) return Promise.reject(dbError);
          return Promise.resolve({ rows, rowCount });
        }),
      };

  const apiStack: any[] = [
    (req: any, _: any, next: any) => { req.tenantId = tenantId; next(); },
  ];

  registerEngagementRoutes(app, apiStack, mockDb);
  return { app, mockDb };
}

const VALID_RULE = {
  trigger_type: 'scroll_depth',
  trigger_config: { threshold: 75 },
  message_template: 'ご興味いただけましたか？',
};

describe('Admin CRUD: /v1/admin/engagement/rules', () => {
  describe('GET 一覧', () => {
    it('super_admin → 全ルール取得 200', async () => {
      const { app, mockDb } = makeApp({
        rows: [
          { id: 1, tenant_id: 'tenant-a', trigger_type: 'scroll_depth', trigger_config: { threshold: 75 }, message_template: 'hi', is_active: true, priority: 10 },
        ],
      });
      const res = await request(app).get('/v1/admin/engagement/rules');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rules)).toBe(true);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('client_admin → 自テナント 200', async () => {
      const { app } = makeApp({ role: 'client_admin', rows: [] });
      const res = await request(app).get('/v1/admin/engagement/rules');
      expect(res.status).toBe(200);
    });

    it('client_admin → 他テナント指定 → 403', async () => {
      const { app } = makeApp({ role: 'client_admin', tenantId: 'tenant-a' });
      const res = await request(app)
        .get('/v1/admin/engagement/rules')
        .query({ tenant_id: 'tenant-b' });
      expect(res.status).toBe(403);
    });

    it('DB null → 503', async () => {
      const { app } = makeApp({ dbNull: true });
      const res = await request(app).get('/v1/admin/engagement/rules');
      expect(res.status).toBe(503);
    });
  });

  describe('POST 新規作成', () => {
    it('正常系 → 201 + rule', async () => {
      const { app } = makeApp({ rows: [{ id: 1, ...VALID_RULE, is_active: true, priority: 0 }] });
      const res = await request(app)
        .post('/v1/admin/engagement/rules')
        .send(VALID_RULE);
      expect(res.status).toBe(201);
      expect(res.body.rule).toBeDefined();
    });

    it('バリデーションエラー (message_template 欠如) → 400', async () => {
      const { app } = makeApp({});
      const res = await request(app)
        .post('/v1/admin/engagement/rules')
        .send({ trigger_type: 'idle_time', trigger_config: { seconds: 30 } });
      expect(res.status).toBe(400);
    });

    it('client_admin 他テナント指定 → 403', async () => {
      const { app } = makeApp({ role: 'client_admin', tenantId: 'tenant-a' });
      const res = await request(app)
        .post('/v1/admin/engagement/rules')
        .send({ ...VALID_RULE, tenant_id: 'tenant-b' });
      expect(res.status).toBe(403);
    });
  });

  describe('PUT 更新', () => {
    it('正常系 → 200 + updated rule', async () => {
      const { app } = makeApp({
        queryResponses: [
          { rows: [{ tenant_id: 'tenant-a', is_active: true }], rowCount: 1 },
          { rows: [{ id: 1, ...VALID_RULE, is_active: true, priority: 5 }], rowCount: 1 },
        ],
      });
      const res = await request(app)
        .put('/v1/admin/engagement/rules/1')
        .send({ ...VALID_RULE, priority: 5 });
      expect(res.status).toBe(200);
    });

    it('存在しないID → 404', async () => {
      const { app } = makeApp({ queryResponses: [{ rows: [], rowCount: 0 }] });
      const res = await request(app)
        .put('/v1/admin/engagement/rules/999')
        .send(VALID_RULE);
      expect(res.status).toBe(404);
    });

    it('client_admin 他テナントルール → 403', async () => {
      const { app } = makeApp({
        role: 'client_admin',
        tenantId: 'tenant-a',
        queryResponses: [{ rows: [{ tenant_id: 'tenant-b' }], rowCount: 1 }],
      });
      const res = await request(app)
        .put('/v1/admin/engagement/rules/1')
        .send(VALID_RULE);
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE 削除', () => {
    it('正常系 → 204', async () => {
      const { app } = makeApp({
        queryResponses: [
          { rows: [{ tenant_id: 'tenant-a' }], rowCount: 1 },
          { rows: [], rowCount: 1 },
        ],
      });
      const res = await request(app).delete('/v1/admin/engagement/rules/1');
      expect(res.status).toBe(204);
    });

    it('存在しないID → 404', async () => {
      const { app } = makeApp({ queryResponses: [{ rows: [], rowCount: 0 }] });
      const res = await request(app).delete('/v1/admin/engagement/rules/999');
      expect(res.status).toBe(404);
    });

    it('client_admin 他テナントルール → 403', async () => {
      const { app } = makeApp({
        role: 'client_admin',
        tenantId: 'tenant-a',
        queryResponses: [{ rows: [{ tenant_id: 'tenant-b' }], rowCount: 1 }],
      });
      const res = await request(app).delete('/v1/admin/engagement/rules/1');
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH toggle', () => {
    it('is_active true→false → 200', async () => {
      const { app } = makeApp({
        queryResponses: [
          { rows: [{ tenant_id: 'tenant-a', is_active: true }], rowCount: 1 },
          { rows: [{ id: 1, is_active: false }], rowCount: 1 },
        ],
      });
      const res = await request(app).patch('/v1/admin/engagement/rules/1/toggle');
      expect(res.status).toBe(200);
      expect(res.body.rule.is_active).toBe(false);
    });

    it('is_active false→true → 200', async () => {
      const { app } = makeApp({
        queryResponses: [
          { rows: [{ tenant_id: 'tenant-a', is_active: false }], rowCount: 1 },
          { rows: [{ id: 1, is_active: true }], rowCount: 1 },
        ],
      });
      const res = await request(app).patch('/v1/admin/engagement/rules/1/toggle');
      expect(res.status).toBe(200);
      expect(res.body.rule.is_active).toBe(true);
    });

    it('存在しないID → 404', async () => {
      const { app } = makeApp({ queryResponses: [{ rows: [], rowCount: 0 }] });
      const res = await request(app).patch('/v1/admin/engagement/rules/999/toggle');
      expect(res.status).toBe(404);
    });
  });
});

describe('Widget API: GET /api/engagement/rules', () => {
  it('アクティブルールのみ返す (priority降順)', async () => {
    const { app } = makeApp({
      rows: [
        { id: 2, trigger_type: 'idle_time', trigger_config: { seconds: 30 }, message_template: 'hi', priority: 10 },
        { id: 1, trigger_type: 'scroll_depth', trigger_config: { threshold: 75 }, message_template: 'hello', priority: 5 },
      ],
    });
    const res = await request(app).get('/api/engagement/rules');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rules)).toBe(true);
    // priority降順の最初はid=2
    expect(res.body.rules[0].id).toBe(2);
  });

  it('tenantId 空 → 401', async () => {
    const { app } = makeApp({ tenantId: '' });
    const res = await request(app).get('/api/engagement/rules');
    expect(res.status).toBe(401);
  });

  it('DB null → 503', async () => {
    const { app } = makeApp({ dbNull: true });
    const res = await request(app).get('/api/engagement/rules');
    expect(res.status).toBe(503);
  });
});
