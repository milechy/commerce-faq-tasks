// src/api/admin/reports/reportsAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2: reports/* ALLOWED_ROLES whitelist + user_metadata removal tests

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('./reportsRepository', () => ({
  listReports: jest.fn().mockResolvedValue([]),
  getReport: jest.fn().mockResolvedValue(null),
  getUnreadCount: jest.fn().mockResolvedValue(0),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerReportRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerReportRoutes(app);
  return app;
}

const ROUTES = [
  '/v1/admin/reports?tenantId=t1',
  '/v1/admin/reports/unread-count?tenantId=t1',
  '/v1/admin/reports/123',
];

beforeEach(() => { jest.clearAllMocks(); });

describe('reports — ALLOWED_ROLES whitelist', () => {
  ROUTES.forEach((path) => {
    it(`GET ${path} — viewer → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
      expect(logger.warn).toHaveBeenCalled();
    });
    it(`GET ${path} — stale JWT (user_metadata.role only) → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
    });
    it(`GET ${path} — null user → 403`, async () => {
      const app = makeApp(null);
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
    });
    it(`GET ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await request(app).get(path);
      expect(res.status).not.toBe(403);
    });
    it(`GET ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await request(app).get(path);
      expect(res.status).not.toBe(403);
    });
  });
});
