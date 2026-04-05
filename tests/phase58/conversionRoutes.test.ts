// tests/phase58/conversionRoutes.test.ts
// Phase58: コンバージョン帰属分析API テスト

import express from 'express';
import request from 'supertest';
import { registerConversionRoutes } from '../../src/api/conversion/conversionRoutes';

jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: { role: req._mockRole ?? 'super_admin', tenant_id: req._mockTenantId ?? 'tenant-a' },
    };
    next();
  },
}));

type Role = 'super_admin' | 'client_admin';

function makeApp(opts: {
  role?: Role;
  tenantId?: string;
  queryResponses?: Array<{ rows: any[]; rowCount?: number } | Error>;
  dbNull?: boolean;
}) {
  const { role = 'super_admin', tenantId = 'tenant-a', queryResponses = [] } = opts;
  const app = express();
  app.use(express.json());

  app.use((req: any, _: any, next: any) => {
    req._mockRole = role;
    req._mockTenantId = tenantId;
    req.tenantId = tenantId;
    next();
  });

  let callCount = 0;
  const mockDb: any = opts.dbNull
    ? null
    : {
        query: jest.fn().mockImplementation(() => {
          const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
          if (resp instanceof Error) return Promise.reject(resp);
          return Promise.resolve(resp);
        }),
      };

  const apiStack = [(req: any, _: any, next: any) => { req.tenantId = tenantId; next(); }];
  registerConversionRoutes(app, apiStack, mockDb);
  return { app, mockDb };
}

const VALID_ATTRIBUTION = {
  conversion_type: 'purchase',
  psychology_principle_used: ['損失回避', '希少性'],
  temp_score_at_conversion: 75,
  session_id: '123e4567-e89b-12d3-a456-426614174000',
};

describe('POST /api/conversion/attribute', () => {
  it('正常系 → 202', async () => {
    const { app, mockDb } = makeApp({ queryResponses: [{ rows: [], rowCount: 1 }] });
    const res = await request(app).post('/api/conversion/attribute').send(VALID_ATTRIBUTION);
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('tenantId 空 → 401', async () => {
    const { app } = makeApp({ tenantId: '' });
    const res = await request(app).post('/api/conversion/attribute').send(VALID_ATTRIBUTION);
    expect(res.status).toBe(401);
  });

  it('conversion_type 無効 → 400', async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post('/api/conversion/attribute')
      .send({ ...VALID_ATTRIBUTION, conversion_type: 'invalid_type' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('conversion_type 欠如 → 400', async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post('/api/conversion/attribute')
      .send({ session_id: '123e4567-e89b-12d3-a456-426614174000' });
    expect(res.status).toBe(400);
  });

  it('DB null → 503', async () => {
    const { app } = makeApp({ dbNull: true });
    const res = await request(app).post('/api/conversion/attribute').send(VALID_ATTRIBUTION);
    expect(res.status).toBe(503);
  });
});

describe('GET /v1/admin/conversion/attributions', () => {
  // Query order: [1] list, [2] by-type summary, [3] overall avg+total, [4] principles
  it('Super Admin → 全テナント 200', async () => {
    const { app } = makeApp({
      role: 'super_admin',
      queryResponses: [
        { rows: [{ id: 1, conversion_type: 'purchase', psychology_principle_used: ['損失回避'] }] },
        { rows: [{ conversion_type: 'purchase', type_count: 1 }] },
        { rows: [{ total: '1', avg_temp_score: '75.0' }] },
        { rows: [{ principle: '損失回避', cnt: 1 }] },
      ],
    });
    const res = await request(app).get('/v1/admin/conversion/attributions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.attributions)).toBe(true);
    expect(res.body.summary).toBeDefined();
  });

  it('avg_temp_score は全体平均 (複数typeでも単一値)', async () => {
    const { app } = makeApp({
      role: 'super_admin',
      queryResponses: [
        { rows: [] },
        // 2 conversion types with different per-group avgs
        { rows: [
          { conversion_type: 'purchase', type_count: 3 },
          { conversion_type: 'inquiry', type_count: 7 },
        ]},
        // Overall average across ALL 10 records
        { rows: [{ total: '10', avg_temp_score: '62.5' }] },
        { rows: [] },
      ],
    });
    const res = await request(app).get('/v1/admin/conversion/attributions');
    expect(res.status).toBe(200);
    // Must be overall avg (62.5→63), not just first group's value
    expect(res.body.summary.avg_temp_score).toBe(63);
    expect(res.body.summary.total).toBe(10);
  });

  it('Client Admin → 自テナント 200', async () => {
    const { app } = makeApp({
      role: 'client_admin',
      queryResponses: [{ rows: [] }, { rows: [] }, { rows: [{ total: '0', avg_temp_score: null }] }, { rows: [] }],
    });
    const res = await request(app).get('/v1/admin/conversion/attributions');
    expect(res.status).toBe(200);
  });

  it('Client Admin → 他テナント → 403', async () => {
    const { app } = makeApp({ role: 'client_admin', tenantId: 'tenant-a' });
    const res = await request(app)
      .get('/v1/admin/conversion/attributions')
      .query({ tenant_id: 'tenant-b' });
    expect(res.status).toBe(403);
  });

  it('DB null → 503', async () => {
    const { app } = makeApp({ dbNull: true });
    const res = await request(app).get('/v1/admin/conversion/attributions');
    expect(res.status).toBe(503);
  });
});

describe('GET /v1/admin/conversion/effectiveness', () => {
  it('心理原則ランキング算出 → 200', async () => {
    const { app } = makeApp({
      role: 'super_admin',
      queryResponses: [
        {
          rows: [
            { principle: '損失回避', count: 10, avg_temp_score: 75 },
            { principle: '社会的証明', count: 7, avg_temp_score: 60 },
          ],
        },
      ],
    });
    const res = await request(app).get('/v1/admin/conversion/effectiveness');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rankings)).toBe(true);
    expect(res.body.rankings[0].principle).toBe('損失回避');
    expect(res.body.rankings[0].count).toBe(10);
  });

  it('Client Admin → 他テナント → 403', async () => {
    const { app } = makeApp({ role: 'client_admin', tenantId: 'tenant-a' });
    const res = await request(app)
      .get('/v1/admin/conversion/effectiveness')
      .query({ tenant_id: 'tenant-b' });
    expect(res.status).toBe(403);
  });
});
