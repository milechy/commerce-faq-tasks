// tests/phase58/abTestRoutes.test.ts
// Phase58: A/Bテスト CRUD API テスト

import express from 'express';
import request from 'supertest';
import { registerAbTestRoutes, assignVariant } from '../../src/api/conversion/abTestRoutes';

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

  registerAbTestRoutes(app, mockDb);
  return { app, mockDb };
}

const VALID_EXPERIMENT = {
  name: 'テスト実験A',
  variant_a: { prompt_modifier: '損失回避を強調' },
  variant_b: { prompt_modifier: '社会的証明を強調' },
  traffic_split: 0.5,
  min_sample_size: 50,
};

describe('GET /v1/admin/ab/experiments', () => {
  it('Super Admin → 200 + experiments配列', async () => {
    const { app } = makeApp({ queryResponses: [{ rows: [{ id: 1, name: 'test', status: 'draft' }] }] });
    const res = await request(app).get('/v1/admin/ab/experiments');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.experiments)).toBe(true);
  });

  it('Client Admin → 他テナント指定 → 403', async () => {
    const { app } = makeApp({ role: 'client_admin', tenantId: 'tenant-a' });
    const res = await request(app).get('/v1/admin/ab/experiments').query({ tenant_id: 'tenant-b' });
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/admin/ab/experiments', () => {
  it('正常系 → 201 + experiment', async () => {
    const { app } = makeApp({ queryResponses: [{ rows: [{ id: 1, ...VALID_EXPERIMENT, status: 'draft' }] }] });
    const res = await request(app).post('/v1/admin/ab/experiments').send(VALID_EXPERIMENT);
    expect(res.status).toBe(201);
    expect(res.body.experiment).toBeDefined();
  });

  it('name 欠如 → 400', async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post('/v1/admin/ab/experiments')
      .send({ variant_a: {}, variant_b: {} });
    expect(res.status).toBe(400);
  });

  it('Client Admin 他テナント → 403', async () => {
    const { app } = makeApp({ role: 'client_admin', tenantId: 'tenant-a' });
    const res = await request(app)
      .post('/v1/admin/ab/experiments')
      .send({ ...VALID_EXPERIMENT, tenant_id: 'tenant-b' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /v1/admin/ab/experiments/:id', () => {
  it('draft → 更新可能 200', async () => {
    const { app } = makeApp({
      queryResponses: [
        { rows: [{ tenant_id: 'tenant-a', status: 'draft' }], rowCount: 1 },
        { rows: [{ id: 1, ...VALID_EXPERIMENT, status: 'draft' }] },
      ],
    });
    const res = await request(app).put('/v1/admin/ab/experiments/1').send(VALID_EXPERIMENT);
    expect(res.status).toBe(200);
  });

  it('running → 更新不可 400', async () => {
    const { app } = makeApp({
      queryResponses: [{ rows: [{ tenant_id: 'tenant-a', status: 'running' }], rowCount: 1 }],
    });
    const res = await request(app).put('/v1/admin/ab/experiments/1').send(VALID_EXPERIMENT);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('only_draft_editable');
  });

  it('存在しないID → 404', async () => {
    const { app } = makeApp({ queryResponses: [{ rows: [], rowCount: 0 }] });
    const res = await request(app).put('/v1/admin/ab/experiments/999').send(VALID_EXPERIMENT);
    expect(res.status).toBe(404);
  });

  it('Client Admin 他テナント → 403', async () => {
    const { app } = makeApp({
      role: 'client_admin',
      tenantId: 'tenant-a',
      queryResponses: [{ rows: [{ tenant_id: 'tenant-b', status: 'draft' }], rowCount: 1 }],
    });
    const res = await request(app).put('/v1/admin/ab/experiments/1').send(VALID_EXPERIMENT);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /v1/admin/ab/experiments/:id/status', () => {
  it('draft → running 200', async () => {
    const { app } = makeApp({
      queryResponses: [
        { rows: [{ tenant_id: 'tenant-a', status: 'draft' }], rowCount: 1 },
        { rows: [{ id: 1, status: 'running' }] },
      ],
    });
    const res = await request(app).patch('/v1/admin/ab/experiments/1/status').send({ status: 'running' });
    expect(res.status).toBe(200);
    expect(res.body.experiment.status).toBe('running');
  });

  it('running → completed 200', async () => {
    const { app } = makeApp({
      queryResponses: [
        { rows: [{ tenant_id: 'tenant-a', status: 'running' }], rowCount: 1 },
        { rows: [{ id: 1, status: 'completed' }] },
      ],
    });
    const res = await request(app).patch('/v1/admin/ab/experiments/1/status').send({ status: 'completed' });
    expect(res.status).toBe(200);
  });

  it('completed → running 400 (不正遷移)', async () => {
    const { app } = makeApp({
      queryResponses: [{ rows: [{ tenant_id: 'tenant-a', status: 'completed' }], rowCount: 1 }],
    });
    const res = await request(app).patch('/v1/admin/ab/experiments/1/status').send({ status: 'running' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_status_transition');
  });

  it('存在しないID → 404', async () => {
    const { app } = makeApp({ queryResponses: [{ rows: [], rowCount: 0 }] });
    const res = await request(app).patch('/v1/admin/ab/experiments/999/status').send({ status: 'running' });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/admin/ab/experiments/:id/results', () => {
  it('variant別 conversion rate 算出 → 200', async () => {
    const { app } = makeApp({
      queryResponses: [
        { rows: [{ tenant_id: 'tenant-a' }], rowCount: 1 },
        {
          rows: [
            { variant: 'a', total: 100, converted: 30, avg_judge_score: 75 },
            { variant: 'b', total: 100, converted: 20, avg_judge_score: 65 },
          ],
        },
      ],
    });
    const res = await request(app).get('/v1/admin/ab/experiments/1/results');
    expect(res.status).toBe(200);
    expect(res.body.variants['a'].conversion_rate).toBe(30);
    expect(res.body.variants['b'].conversion_rate).toBe(20);
  });

  it('存在しないID → 404', async () => {
    const { app } = makeApp({ queryResponses: [{ rows: [], rowCount: 0 }] });
    const res = await request(app).get('/v1/admin/ab/experiments/999/results');
    expect(res.status).toBe(404);
  });
});

describe('assignVariant', () => {
  it('同一visitorIdは常に同じvariantを返す（決定的）', () => {
    const vid = 'visitor-abc-123';
    const v1 = assignVariant(vid, 0.5);
    const v2 = assignVariant(vid, 0.5);
    expect(v1).toBe(v2);
  });

  it('返り値は "a" または "b"', () => {
    const v = assignVariant('test-visitor', 0.5);
    expect(['a', 'b']).toContain(v);
  });

  it('trafficSplit=1.0 → 常に "a"', () => {
    expect(assignVariant('any-visitor', 1.0)).toBe('a');
  });

  it('trafficSplit=0.0 → 常に "b"', () => {
    expect(assignVariant('any-visitor', 0.0)).toBe('b');
  });
});
