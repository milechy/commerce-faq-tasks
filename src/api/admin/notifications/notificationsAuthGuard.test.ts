// src/api/admin/notifications/notificationsAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2

jest.mock('../../../lib/db', () => ({
  pool: null,
  getPool: () => null,
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerNotificationRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerNotificationRoutes(app);
  return app;
}

const TENANT_SCOPED = [
  { method: 'get' as const, path: '/v1/admin/notifications' },
  { method: 'patch' as const, path: '/v1/admin/notifications/read-all' },
  { method: 'patch' as const, path: '/v1/admin/notifications/123/read' },
];
const SUPER_ADMIN_ONLY = [
  { method: 'post' as const, path: '/v1/admin/notifications' },
];
const ALL_ROUTES = [...TENANT_SCOPED, ...SUPER_ADMIN_ONLY];

beforeEach(() => { jest.clearAllMocks(); });

describe('notifications — ALLOWED_ROLES whitelist', () => {
  ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({
        recipient_tenant_id: 't1', title: 'x', message: 'y',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
      expect(logger.warn).toHaveBeenCalled();
    });
    it(`${method.toUpperCase()} ${path} — stale JWT → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — null user → 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).toBe(403);
    });
  });
});

describe('notifications — TENANT_SCOPED allow', () => {
  TENANT_SCOPED.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).not.toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).not.toBe(403);
    });
  });
});

describe('notifications — SUPER_ADMIN_ONLY denies client_admin', () => {
  SUPER_ADMIN_ONLY.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin → 403 AUTHZ_ROLE_DENIED`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({
        recipient_tenant_id: 't1', title: 'x', message: 'y',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    });
  });
});
