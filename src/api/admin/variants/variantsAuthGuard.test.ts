// src/api/admin/variants/variantsAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2: variants/* ALLOWED_ROLES whitelist + user_metadata removal tests

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('./variantsRepository', () => ({
  listVariants: jest.fn().mockResolvedValue([]),
  upsertVariants: jest.fn().mockResolvedValue([]),
  getVariantStats: jest.fn().mockResolvedValue([]),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerVariantRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerVariantRoutes(app);
  return app;
}

const ALL_ROUTES = [
  { method: 'get' as const, path: '/v1/admin/variants?tenantId=t1' },
  { method: 'get' as const, path: '/v1/admin/variants/stats?tenantId=t1' },
  { method: 'put' as const, path: '/v1/admin/variants' },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('variants — ALLOWED_ROLES whitelist', () => {
  ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403 AUTHZ_ROLE_DENIED`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
      const body = method === 'put' ? { tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 100 }] } : {};
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
      expect(logger.warn).toHaveBeenCalled();
    });
    it(`${method.toUpperCase()} ${path} — stale JWT (user_metadata.role only) → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const body = method === 'put' ? { tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 100 }] } : {};
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    });
    it(`${method.toUpperCase()} ${path} — null user → 403`, async () => {
      const app = makeApp(null);
      const body = method === 'put' ? { tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 100 }] } : {};
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const body = method === 'put' ? { tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 100 }] } : {};
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).not.toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const body = method === 'put' ? { tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 100 }] } : {};
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).not.toBe(403);
    });
  });
});

describe('variants — cross-tenant query guard (GET) / cross-tenant write guard (PUT)', () => {
  const clientAdmin = { app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' };

  it('GET /v1/admin/variants?tenantId=t2 — client_adminの自テナントと不一致 → 403', async () => {
    const app = makeApp(clientAdmin);
    const res = await request(app).get('/v1/admin/variants?tenantId=t2');
    expect(res.status).toBe(403);
  });

  it('PUT /v1/admin/variants { tenantId: "t2" } — client_adminの自テナントと不一致 → 403', async () => {
    const app = makeApp(clientAdmin);
    const res = await request(app)
      .put('/v1/admin/variants')
      .send({ tenantId: 't2', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 100 }] });
    expect(res.status).toBe(403);
  });
});

describe('variants — PUT: weight合計バリデーション（境界値）', () => {
  const su = { app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' };

  it('合計99 → 400（1でも足りないと拒否）', async () => {
    const app = makeApp(su);
    const res = await request(app)
      .put('/v1/admin/variants')
      .send({ tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 99 }] });
    expect(res.status).toBe(400);
  });

  it('合計101 → 400（1でも超えると拒否）', async () => {
    const app = makeApp(su);
    const res = await request(app)
      .put('/v1/admin/variants')
      .send({ tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 101 }] });
    expect(res.status).toBe(400);
  });

  it('3件の按分 33+33+34=100 → 通過する', async () => {
    const app = makeApp(su);
    const res = await request(app)
      .put('/v1/admin/variants')
      .send({
        tenantId: 't1',
        variants: [
          { id: 'a', name: 'A', prompt: 'p', weight: 33 },
          { id: 'b', name: 'B', prompt: 'p', weight: 33 },
          { id: 'c', name: 'C', prompt: 'p', weight: 34 },
        ],
      });
    expect(res.status).not.toBe(400);
  });

  it('weightが小数(33.3) → zodのint()制約で400', async () => {
    const app = makeApp(su);
    const res = await request(app)
      .put('/v1/admin/variants')
      .send({ tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: 33.3 }] });
    expect(res.status).toBe(400);
  });

  it('variantsが空配列 → 400（zod min(1)）', async () => {
    const app = makeApp(su);
    const res = await request(app).put('/v1/admin/variants').send({ tenantId: 't1', variants: [] });
    expect(res.status).toBe(400);
  });

  it('weightが範囲外(101超・負数)の単一要素 → 400', async () => {
    const app = makeApp(su);
    const res = await request(app)
      .put('/v1/admin/variants')
      .send({ tenantId: 't1', variants: [{ id: 'a', name: 'A', prompt: 'p', weight: -10 }] });
    expect(res.status).toBe(400);
  });
});

describe('variants — GET /stats: days パラメータの境界値（parseDays）', () => {
  const su = { app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' };

  [
    { days: '0', label: '0以下は既定値にフォールバック' },
    { days: '-5', label: '負数は既定値にフォールバック' },
    { days: 'abc', label: '非数値は既定値にフォールバック' },
    { days: '366', label: '365超過はクランプされる（例外にならない）' },
    { days: '99999999999999', label: '極端に大きい値でもクラッシュしない' },
  ].forEach(({ days, label }) => {
    it(`days=${JSON.stringify(days)} — ${label}`, async () => {
      const app = makeApp(su);
      const res = await request(app).get(`/v1/admin/variants/stats?tenantId=t1&days=${encodeURIComponent(days)}`);
      // parseDaysは常に有限の安全な値へ丸め込むため、ここで500になってはいけない
      expect(res.status).not.toBe(500);
    });
  });
});
