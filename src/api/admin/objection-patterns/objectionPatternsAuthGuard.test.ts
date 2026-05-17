// src/api/admin/objection-patterns/objectionPatternsAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('./objectionPatternsRepository', () => ({
  listObjectionPatterns: jest.fn().mockResolvedValue([]),
  getObjectionPattern: jest.fn().mockResolvedValue(null),
  deleteObjectionPattern: jest.fn().mockResolvedValue(true),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerObjectionPatternRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerObjectionPatternRoutes(app);
  return app;
}

const ROUTES = [
  { method: 'get' as const, path: '/v1/admin/objection-patterns?tenantId=t1' },
  { method: 'get' as const, path: '/v1/admin/objection-patterns/123' },
  { method: 'delete' as const, path: '/v1/admin/objection-patterns/123' },
];

beforeEach(() => { jest.clearAllMocks(); });

describe('objection-patterns — ALLOWED_ROLES whitelist', () => {
  ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
      expect(logger.warn).toHaveBeenCalled();
    });
    it(`${method.toUpperCase()} ${path} — stale JWT (user_metadata.role only) → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — null user → 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
  });
});
