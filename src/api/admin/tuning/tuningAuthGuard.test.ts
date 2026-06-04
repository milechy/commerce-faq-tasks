// src/api/admin/tuning/tuningAuthGuard.test.ts
// Phase69-1.5 PR-C3: tuning/* ALLOWED_ROLES whitelist + user_metadata removal tests
// Validates that tuning endpoints reject non-admin roles and stale JWTs.

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
jest.mock('./tuningRulesRepository', () => ({
  listRules: jest.fn().mockResolvedValue([]),
  createRule: jest.fn().mockResolvedValue({ id: 1 }),
  updateRule: jest.fn().mockResolvedValue({ id: 1 }),
  deleteRule: jest.fn().mockResolvedValue({ id: 1 }),
}));
jest.mock('../../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn().mockResolvedValue({ results: [] }),
  formatKnowledgeContext: jest.fn().mockReturnValue(''),
}));
jest.mock('../../../lib/crossTenantContext', () => ({
  getCrossTenantContext: jest.fn().mockResolvedValue({
    avgScores: null,
    topPsychologyPrinciples: [],
    commonGapPatterns: [],
    effectiveRulePatterns: [],
    totalTenants: 0,
    dataAsOf: new Date().toISOString(),
  }),
  formatCrossTenantContext: jest.fn().mockReturnValue(''),
}));
jest.mock('../../../lib/research', () => ({
  getResearchProvider: jest.fn().mockReturnValue(null),
}));
jest.mock('../../../lib/research/featureCheck', () => ({
  isDeepResearchEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../lib/research/queryBuilder', () => ({
  buildResearchQuery: jest.fn().mockReturnValue(''),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerTuningRoutes } from './routes';
import { registerTestResponseRoutes } from './testResponseRoutes';

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function makeApp(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata
      ? { app_metadata: appMetadata, email: 'test@test.com' }
      : null;
    next();
  });
  registerTuningRoutes(app);
  registerTestResponseRoutes(app);
  return app;
}

function makeAppWithUser(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerTuningRoutes(app);
  registerTestResponseRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

const TUNING_ALL_ROUTES = [
  { method: 'get' as const, path: '/v1/admin/tuning-rules' },
  { method: 'post' as const, path: '/v1/admin/tuning-rules' },
  { method: 'put' as const, path: '/v1/admin/tuning-rules/1' },
  { method: 'delete' as const, path: '/v1/admin/tuning-rules/1' },
  { method: 'post' as const, path: '/v1/admin/tuning/suggest-rule' },
  { method: 'post' as const, path: '/v1/admin/tuning-rules/1/test-responses' },
];

// Routes accessible to both super_admin and client_admin (with tenant ownership)
const TUNING_ANY_ADMIN_ROUTES = [
  { method: 'get' as const, path: '/v1/admin/tuning-rules' },
  { method: 'post' as const, path: '/v1/admin/tuning/suggest-rule' },
];

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist: viewer → 403
// ---------------------------------------------------------------------------

describe('tuning routes — ALLOWED_ROLES whitelist (viewer → 403)', () => {
  TUNING_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist: no role → 403
// ---------------------------------------------------------------------------

describe('tuning routes — ALLOWED_ROLES whitelist (no role → 403)', () => {
  TUNING_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — no role → 403`, async () => {
      const app = makeApp({ tenant_id: 'tenant-a' }); // role absent
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Stale JWT: user_metadata.role only → 403
// ---------------------------------------------------------------------------

describe('tuning routes — stale JWT (user_metadata.role only) → 403', () => {
  TUNING_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — stale JWT → 403`, async () => {
      const app = makeAppWithUser({
        user_metadata: { role: 'super_admin' }, // old JWT, no app_metadata.role
        email: 'stale@test.com',
      });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Allow-path: super_admin passes ALLOWED_ROLES guard
// ---------------------------------------------------------------------------

describe('tuning routes — allow-path: super_admin passes ALLOWED_ROLES guard', () => {
  TUNING_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ role: 'super_admin', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Allow-path: client_admin passes ANY_ADMIN routes
// ---------------------------------------------------------------------------

describe('tuning routes — allow-path: client_admin passes ANY_ADMIN routes', () => {
  TUNING_ANY_ADMIN_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin + tenant_id → not 403`, async () => {
      const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
  });

  it('PUT /v1/admin/tuning-rules/1 — client_admin with own tenant → not 403 (ownership checked post-auth)', async () => {
    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    const res = await request(app)
      .put('/v1/admin/tuning-rules/1')
      .send({ trigger_pattern: 'test', expected_behavior: 'test' });
    expect(res.status).not.toBe(403);
  });

  it('DELETE /v1/admin/tuning-rules/1 — client_admin → not 403 (ownership checked post-auth)', async () => {
    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    const res = await request(app).delete('/v1/admin/tuning-rules/1');
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Observability: logger.warn on 403
// ---------------------------------------------------------------------------

describe('tuning routes — logger.warn structured payload on 403 (observability)', () => {
  it('GET /v1/admin/tuning-rules — viewer → logger.warn with AUTHZ_ROLE_DENIED', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/tuning-rules');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tuning_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        hasAppMetadataRole: true,
        hasUserMetadataRole: false,
      }),
      expect.any(String),
    );
  });

  it('POST /v1/admin/tuning/suggest-rule — no role → logger.warn with AUTHZ_ROLE_DENIED', async () => {
    const app = makeApp({ tenant_id: 'tenant-a' }); // no role
    await request(app).post('/v1/admin/tuning/suggest-rule').send({ userMessage: 'test', aiMessage: 'test' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tuning_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        hasAppMetadataRole: false,
      }),
      expect.any(String),
    );
  });

  it('POST /v1/admin/tuning-rules/1/test-responses — viewer → logger.warn with AUTHZ_ROLE_DENIED', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    await request(app).post('/v1/admin/tuning-rules/1/test-responses');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tuning_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
      }),
      expect.any(String),
    );
  });

  it('403 response includes errorCode field', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    const res = await request(app).get('/v1/admin/tuning-rules');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AUTHZ_ROLE_DENIED' });
  });
});
