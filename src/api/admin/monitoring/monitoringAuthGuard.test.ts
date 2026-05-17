// src/api/admin/monitoring/monitoringAuthGuard.test.ts
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
jest.mock('../../../lib/db', () => ({
  getPool: () => null,
  pool: null,
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerMonitoringRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerMonitoringRoutes(app);
  return app;
}

const PATH = '/v1/admin/monitoring/kpis';

beforeEach(() => { jest.clearAllMocks(); });

describe('monitoring — ALLOWED_ROLES whitelist', () => {
  it('viewer → 403 AUTHZ_ROLE_DENIED', async () => {
    const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    expect(logger.warn).toHaveBeenCalled();
  });
  it('stale JWT (user_metadata.role only) → 403', async () => {
    const app = makeApp({ user_metadata: { role: 'super_admin' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
  });
  it('top-level role only → 403 (no app_metadata)', async () => {
    const app = makeApp({ role: 'super_admin', email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
  });
  it('null user → 403', async () => {
    const app = makeApp(null);
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
  });
  it('super_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).not.toBe(403);
  });
  it('client_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).not.toBe(403);
  });
});
