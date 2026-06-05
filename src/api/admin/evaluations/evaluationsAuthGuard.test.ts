// src/api/admin/evaluations/evaluationsAuthGuard.test.ts
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
jest.mock('./evaluationsRepository', () => ({
  listEvaluations: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  getDetailedStats: jest.fn().mockResolvedValue({}),
  getEvaluationsBySession: jest.fn().mockResolvedValue([]),
  updateOutcome: jest.fn().mockResolvedValue({ id: 1 }),
  getKpiStats: jest.fn().mockResolvedValue({}),
  approveTuningRule: jest.fn().mockResolvedValue({ id: 1 }),
  rejectTuningRule: jest.fn().mockResolvedValue({ id: 1 }),
  getEvaluationById: jest.fn().mockResolvedValue(null),
  checkAlreadyEvaluated: jest.fn().mockResolvedValue(false),
  updateSuggestedRuleStatus: jest.fn().mockResolvedValue({ id: 1 }),
  insertTuningRuleFromSuggestion: jest.fn().mockResolvedValue(1),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerEvaluationRoutes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerEvaluationRoutes(app);
  return app;
}

const ROUTES = [
  { method: 'get' as const, path: '/v1/admin/evaluations' },
  { method: 'get' as const, path: '/v1/admin/evaluations/stats' },
  { method: 'get' as const, path: '/v1/admin/evaluations/kpi-stats' },
  { method: 'post' as const, path: '/v1/admin/evaluations/trigger' },
  { method: 'get' as const, path: '/v1/admin/evaluations/by-id/123' },
  { method: 'patch' as const, path: '/v1/admin/evaluations/123/rules/0' },
  { method: 'get' as const, path: '/v1/admin/evaluations/sess123' },
  { method: 'put' as const, path: '/v1/admin/evaluations/123/outcome' },
  { method: 'put' as const, path: '/v1/admin/tuning/123/approve' },
  { method: 'put' as const, path: '/v1/admin/tuning/123/reject' },
];

beforeEach(() => { jest.clearAllMocks(); });

describe('evaluations — ALLOWED_ROLES whitelist', () => {
  ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ session_id: 's', action: 'approve', outcome: 'replied' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
      expect(logger.warn).toHaveBeenCalled();
    });
    it(`${method.toUpperCase()} ${path} — stale JWT → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ session_id: 's', action: 'approve', outcome: 'replied' });
      expect(res.status).toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — null user → 401 or 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path).send({ session_id: 's', action: 'approve', outcome: 'replied' });
      // PATCH rules/:id uses supabaseAuthMiddleware twice — null user → 401; others → 403
      expect([401, 403]).toContain(res.status);
    });
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ session_id: 's', action: 'approve', outcome: 'replied' });
      expect(res.status).not.toBe(403);
    });
    it(`${method.toUpperCase()} ${path} — client_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
      const res = await (request(app) as any)[method](path).send({ session_id: 's', action: 'approve', outcome: 'replied' });
      expect(res.status).not.toBe(403);
    });
  });
});
