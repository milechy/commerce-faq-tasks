// src/api/admin/feedback/feedbackAuthGuard.test.ts
// Phase69-1.5 PR-C3: feedback/* ALLOWED_ROLES whitelist + user_metadata removal tests
// Validates that feedback endpoints reject non-admin roles and stale JWTs.

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
jest.mock('./feedbackRepository', () => ({
  getMessages: jest.fn().mockResolvedValue({ messages: [], total: 0 }),
  sendMessage: jest.fn().mockResolvedValue({ id: 1, content: 'test' }),
  getThreads: jest.fn().mockResolvedValue([]),
  markAsRead: jest.fn().mockResolvedValue(undefined),
  markSuperAdminMessagesAsRead: jest.fn().mockResolvedValue(undefined),
  getUnreadCount: jest.fn().mockResolvedValue(0),
  flagMessage: jest.fn().mockResolvedValue({ id: 1, flagged_for_improvement: true, created_at: new Date() }),
}));
jest.mock('./feedbackAI', () => ({
  generateFeedbackReply: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../lib/security/inputSanitizer', () => ({
  sanitizeInput: jest.fn().mockReturnValue({ safe: true }),
  blockReasonToMessage: jest.fn().mockReturnValue('blocked'),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerFeedbackRoutes } from './feedbackRoutes';
import { registerAdminFeedbackManagementRoutes } from './routes';

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function makeAppFeedback(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata, email: 'test@test.com' } : null;
    next();
  });
  registerFeedbackRoutes(app);
  return app;
}

function makeAppFeedbackWithUser(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerFeedbackRoutes(app);
  return app;
}

function makeAppMgmt(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata, email: 'test@test.com' } : null;
    next();
  });
  registerAdminFeedbackManagementRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

// feedbackRoutes.ts routes
const FB_ANY_ADMIN_ROUTES = [
  { method: 'get' as const, path: '/v1/admin/feedback' },
  { method: 'post' as const, path: '/v1/admin/feedback' },
  { method: 'patch' as const, path: '/v1/admin/feedback/read' },
  { method: 'get' as const, path: '/v1/admin/feedback/unread-count' },
];
const FB_SUPER_ADMIN_ONLY_ROUTES = [
  { method: 'get' as const, path: '/v1/admin/feedback/threads' },
  { method: 'patch' as const, path: '/v1/admin/feedback/123/flag' },
];
const FB_ALL_ROUTES = [...FB_ANY_ADMIN_ROUTES, ...FB_SUPER_ADMIN_ONLY_ROUTES];

// feedback/routes.ts (management) routes
const MGMT_ANY_ADMIN_ROUTES = [
  { method: 'get' as const, path: '/v1/admin/feedback' },
  { method: 'post' as const, path: '/v1/admin/feedback' },
];
const MGMT_SUPER_ADMIN_ONLY_ROUTES = [
  { method: 'patch' as const, path: '/v1/admin/feedback/123' },
  { method: 'delete' as const, path: '/v1/admin/feedback/123' },
];
const MGMT_ALL_ROUTES = [...MGMT_ANY_ADMIN_ROUTES, ...MGMT_SUPER_ADMIN_ONLY_ROUTES];

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// feedbackRoutes.ts — ALLOWED_ROLES whitelist
// ---------------------------------------------------------------------------

describe('feedbackRoutes — ALLOWED_ROLES whitelist (viewer → 403)', () => {
  FB_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeAppFeedback({ role: 'viewer', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

describe('feedbackRoutes — ALLOWED_ROLES whitelist (no role → 403)', () => {
  FB_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — no role → 403`, async () => {
      const app = makeAppFeedback({ tenant_id: 'tenant-a' }); // role absent
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// feedbackRoutes.ts — super_admin-only routes reject client_admin
// ---------------------------------------------------------------------------

describe('feedbackRoutes — super_admin-only routes reject client_admin', () => {
  FB_SUPER_ADMIN_ONLY_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin → 403`, async () => {
      const app = makeAppFeedback({ role: 'client_admin', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// feedbackRoutes.ts — stale JWT (user_metadata.role only) → 403
// ---------------------------------------------------------------------------

describe('feedbackRoutes — stale JWT (user_metadata.role only) → 403', () => {
  FB_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — stale JWT → 403`, async () => {
      const app = makeAppFeedbackWithUser({
        user_metadata: { role: 'super_admin' }, // old JWT, no app_metadata.role
        email: 'stale@test.com',
      });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// feedbackRoutes.ts — allow-path: super_admin passes guards
// ---------------------------------------------------------------------------

describe('feedbackRoutes — allow-path: super_admin passes ALLOWED_ROLES guard', () => {
  FB_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeAppFeedback({ role: 'super_admin' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// feedbackRoutes.ts — allow-path: client_admin passes ANY_ADMIN routes
// ---------------------------------------------------------------------------

describe('feedbackRoutes — allow-path: client_admin passes ANY_ADMIN routes', () => {
  FB_ANY_ADMIN_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin + tenant_id → not 403`, async () => {
      const app = makeAppFeedback({ role: 'client_admin', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// feedbackRoutes.ts — observability: logger.warn on 403
// ---------------------------------------------------------------------------

describe('feedbackRoutes — logger.warn structured payload on 403 (observability)', () => {
  it('GET /v1/admin/feedback/threads — viewer → logger.warn with AUTHZ_ROLE_DENIED', async () => {
    const app = makeAppFeedback({ role: 'viewer', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/feedback/threads');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'feedback_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        hasAppMetadataRole: true,
        hasUserMetadataRole: false,
      }),
      expect.any(String),
    );
  });

  it('GET /v1/admin/feedback/threads — client_admin → logger.warn with insufficient_role', async () => {
    const app = makeAppFeedback({ role: 'client_admin', tenant_id: 'tenant-a' });
    await request(app).get('/v1/admin/feedback/threads');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'feedback_access_denied',
        reason: 'insufficient_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        required_roles: ['super_admin'],
      }),
      expect.any(String),
    );
  });

  it('403 response includes errorCode field', async () => {
    const app = makeAppFeedback({ role: 'viewer', tenant_id: 'tenant-a' });
    const res = await request(app).get('/v1/admin/feedback');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AUTHZ_ROLE_DENIED' });
  });
});

// ---------------------------------------------------------------------------
// feedback/routes.ts (management) — ALLOWED_ROLES whitelist
// ---------------------------------------------------------------------------

describe('feedback management routes — ALLOWED_ROLES whitelist (viewer → 403)', () => {
  MGMT_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeAppMgmt({ role: 'viewer', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

describe('feedback management routes — ALLOWED_ROLES whitelist (no role → 403)', () => {
  MGMT_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — no role → 403`, async () => {
      const app = makeAppMgmt({ tenant_id: 'tenant-a' }); // role absent
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

describe('feedback management routes — super_admin-only routes reject client_admin', () => {
  MGMT_SUPER_ADMIN_ONLY_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin → 403`, async () => {
      const app = makeAppMgmt({ role: 'client_admin', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

describe('feedback management routes — stale JWT (user_metadata.role only) → 403', () => {
  MGMT_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — stale JWT → 403`, async () => {
      // Inject full user object with user_metadata only (stale JWT)
      const staleApp = express();
      staleApp.use(express.json());
      staleApp.use((req: any, _res: any, next: any) => {
        req._mockUser = { user_metadata: { role: 'super_admin' }, email: 'stale@test.com' };
        next();
      });
      registerAdminFeedbackManagementRoutes(staleApp);
      const res = await (request(staleApp) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

describe('feedback management routes — allow-path: super_admin passes ALLOWED_ROLES', () => {
  MGMT_ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — super_admin + tenant_id → not 403`, async () => {
      // tenant_id required for business validation; test verifies AUTHZ guard passes
      const app = makeAppMgmt({ role: 'super_admin', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
  });
});

describe('feedback management routes — allow-path: client_admin passes ANY_ADMIN routes', () => {
  MGMT_ANY_ADMIN_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin + tenant_id → not 403`, async () => {
      const app = makeAppMgmt({ role: 'client_admin', tenant_id: 'tenant-a' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(403);
    });
  });
});
