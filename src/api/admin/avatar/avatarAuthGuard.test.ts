// src/api/admin/avatar/avatarAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2 — avatar/* (★ PR-C4 v1 で漏れたファイル)

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('../../../auth/supabaseClient', () => ({
  supabaseAdmin: null,
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerAvatarConfigRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const fakeDb = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerAvatarConfigRoutes(app, fakeDb);
  return app;
}

const TENANT_SCOPED = [
  { method: 'get' as const, path: '/v1/admin/avatar/configs' },
  { method: 'post' as const, path: '/v1/admin/avatar/configs' },
  { method: 'patch' as const, path: '/v1/admin/avatar/configs/123' },
  { method: 'delete' as const, path: '/v1/admin/avatar/configs/123' },
  { method: 'post' as const, path: '/v1/admin/avatar/configs/123/activate' },
  { method: 'post' as const, path: '/v1/admin/avatar/configs/123/reset-to-default' },
];
const SUPER_ADMIN_ONLY = [
  { method: 'post' as const, path: '/v1/admin/avatar/defaults/upload' },
  { method: 'get' as const, path: '/v1/admin/avatar/configs/all' },
];
const ALL = [...TENANT_SCOPED, ...SUPER_ADMIN_ONLY];

beforeEach(() => { jest.clearAllMocks(); });

describe('avatar — ALLOWED_ROLES whitelist', () => {
  ALL.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ name: 'a' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
      expect(logger.warn).toHaveBeenCalled();
    });
    it(`${method.toUpperCase()} ${path} — stale JWT → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ name: 'a' });
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — null user → 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path).send({ name: 'a' });
      expect(res.status).toBe(403);
    });
  });
});

describe('avatar SUPER_ADMIN_ONLY denies client_admin', () => {
  SUPER_ADMIN_ONLY.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin → 403 AUTHZ_ROLE_DENIED`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    });
  });
});

describe('avatar TENANT_SCOPED allow', () => {
  TENANT_SCOPED.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ name: 'a' });
      expect(res.status).not.toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ name: 'a' });
      expect(res.status).not.toBe(403);
    });
  });
});
