// src/api/admin/analytics/analyticsAuthGuard.test.ts
// Phase69-1.5: analytics/* ALLOWED_ROLES whitelist + tenant_id fail-closed regression tests
// Codex adversarial-review Round 2 findings: analytics endpoints did not reject
// non-admin roles or client_admin with missing app_metadata.tenant_id.

jest.mock('../../../lib/db', () => ({
  pool: null,
  getPool: () => null,
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn(),
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
import { registerAnalyticsRoutes } from './routes';
import { registerEventAnalyticsRoutes } from './eventAnalyticsRoutes';

function makeApp(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata } : null;
    next();
  });
  registerAnalyticsRoutes(app);
  registerEventAnalyticsRoutes(app);
  return app;
}

// Routes that enforce both ALLOWED_ROLES and non-super-admin tenant_id presence
const TENANT_SCOPED_ROUTES = [
  '/v1/admin/analytics/summary',
  '/v1/admin/analytics/trends',
  '/v1/admin/analytics/evaluations',
  '/v1/admin/analytics/conversions',
  '/v1/admin/analytics/knowledge-attribution',
  '/v1/admin/analytics/events',
];

// All routes including super_admin-only cv-status
const ALL_ROUTES = [...TENANT_SCOPED_ROUTES, '/v1/admin/analytics/cv-status'];

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Whitelist: viewer role → 403
// ---------------------------------------------------------------------------
describe('analytics routes — ALLOWED_ROLES whitelist (viewer → 403)', () => {
  ALL_ROUTES.forEach((route) => {
    it(`${route} — viewer → 403`, async () => {
      const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
      const res = await request(app).get(route);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Whitelist: undefined role → 403
// ---------------------------------------------------------------------------
describe('analytics routes — ALLOWED_ROLES whitelist (no role → 403)', () => {
  ALL_ROUTES.forEach((route) => {
    it(`${route} — no role → 403`, async () => {
      const app = makeApp({ tenant_id: 'tenant-a' }); // role absent
      const res = await request(app).get(route);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: client_admin without app_metadata.tenant_id → 403
// cv-status is super_admin-only and rejects client_admin at the isSuperAdmin check,
// so it is excluded from this specific tenant guard scenario.
// ---------------------------------------------------------------------------
describe('analytics routes — tenant_id fail-closed (client_admin + no tenant → 403)', () => {
  TENANT_SCOPED_ROUTES.forEach((route) => {
    it(`${route} — client_admin + no tenant → 403`, async () => {
      const app = makeApp({ role: 'client_admin' }); // tenant_id absent
      const res = await request(app).get(route);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Observability: logger.warn called with structured payload on 403 denials
// ---------------------------------------------------------------------------
describe('analytics routes — logger.warn structured payload on 403 (observability)', () => {
  it('/v1/admin/analytics/summary — viewer → logger.warn with AUTH_ROLE_INVALID', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/analytics/summary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTH_ROLE_INVALID',
        hasAppMetadataRole: true,
        hasUserMetadataRole: false,
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/summary — no role → logger.warn with AUTH_ROLE_INVALID', async () => {
    const app = makeApp({ tenant_id: 'tenant-a' }); // role absent
    await request(app).get('/v1/admin/analytics/summary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTH_ROLE_INVALID',
        hasAppMetadataRole: false,
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/summary — client_admin + no tenant → logger.warn with AUTH_TENANT_INVALID', async () => {
    const app = makeApp({ role: 'client_admin' }); // tenant_id absent
    await request(app).get('/v1/admin/analytics/summary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'tenant_id_missing',
        errorCode: 'AUTH_TENANT_INVALID',
        hasAppMetadataTenantId: false,
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/events — viewer → logger.warn with AUTH_ROLE_INVALID', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/analytics/events');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTH_ROLE_INVALID',
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/events — client_admin + no tenant → logger.warn with AUTH_TENANT_INVALID', async () => {
    const app = makeApp({ role: 'client_admin' }); // tenant_id absent
    await request(app).get('/v1/admin/analytics/events');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'tenant_id_missing',
        errorCode: 'AUTH_TENANT_INVALID',
      }),
      expect.any(String),
    );
  });

  it('/v1/admin/analytics/cv-status — client_admin (insufficient role) → logger.warn with AUTH_ROLE_INSUFFICIENT', async () => {
    const app = makeApp({ role: 'client_admin', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/analytics/cv-status');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'analytics_access_denied',
        reason: 'insufficient_role',
        errorCode: 'AUTH_ROLE_INSUFFICIENT',
      }),
      expect.any(String),
    );
  });

  it('403 response includes errorCode field', async () => {
    const app = makeApp({ role: 'viewer', tenant_id: 'tenant-a' });
    const res = await request(app).get('/v1/admin/analytics/summary');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AUTH_ROLE_INVALID' });
  });
});
