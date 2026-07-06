// src/api/admin/options/optionsAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2: options/* ALLOWED_ROLES whitelist + user_metadata removal tests

jest.mock('../../../lib/db', () => ({
  pool: null,
  getPool: () => null,
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/billing/stripeSync', () => ({
  chargeOneOffJpy: jest.fn(),
}));
jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
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
import { registerOptionRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerOptionRoutes(app);
  return app;
}

const TENANT_SCOPED = [
  { method: 'get' as const, path: '/v1/admin/options' },
  { method: 'post' as const, path: '/v1/admin/options' },
];
const SUPER_ADMIN_ONLY = [
  { method: 'put' as const, path: '/v1/admin/options/123' },
  { method: 'put' as const, path: '/v1/admin/options/123/complete' },
];
const ALL_ROUTES = [...TENANT_SCOPED, ...SUPER_ADMIN_ONLY];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('options — ALLOWED_ROLES whitelist (viewer denied)', () => {
  ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403 AUTHZ_ROLE_DENIED`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 'test@test.com' });
      const res = await (request(app) as any)[method](path).send({ description: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});

describe('options — stale JWT (user_metadata.role only)', () => {
  ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — user_metadata.role=super_admin (no app_metadata) → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ description: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    });
  });
});

describe('options — null user', () => {
  ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — no supabaseUser → 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path).send({ description: 'x' });
      expect(res.status).toBe(403);
    });
  });
});

describe('options — TENANT_SCOPED allow (super_admin / client_admin)', () => {
  TENANT_SCOPED.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ description: 'x' });
      expect(res.status).not.toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ description: 'x' });
      expect(res.status).not.toBe(403);
    });
  });
});

describe('options — SUPER_ADMIN_ONLY (client_admin denied with insufficient_role)', () => {
  SUPER_ADMIN_ONLY.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin → 403 AUTHZ_ROLE_DENIED`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    });
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).not.toBe(403);
    });
  });
});
