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
