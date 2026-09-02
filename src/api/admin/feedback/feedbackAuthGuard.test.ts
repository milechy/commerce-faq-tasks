// src/api/admin/feedback/feedbackAuthGuard.test.ts
// Phase69-1.5 PR-C3: feedback/* ALLOWED_ROLES whitelist + user_metadata removal tests
// Validates that feedback endpoints reject non-admin roles and stale JWTs.
//
// NOTE(2026-09-02): 旧チャット系フィードバック機能(feedbackRoutes.ts)を提供していた
// registerFeedbackRoutes は廃止した(Asana GID 1218086285251452)ため、それを対象にしていた
// テストブロックも削除した。このファイルは admin_feedback(チケット管理) の
// registerAdminFeedbackManagementRoutes のみを検証する。

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
import { request } from "../../../../tests/helpers/testServer";
import { registerAdminFeedbackManagementRoutes } from './routes';

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

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

// feedback/routes.ts (management) routes
const MGMT_ANY_ADMIN_ROUTES = [
  { method: 'get' as const, path: '/v1/admin/feedback' },
  { method: 'post' as const, path: '/v1/admin/feedback' },
  { method: 'patch' as const, path: '/v1/admin/feedback/123/read' },
];
const MGMT_SUPER_ADMIN_ONLY_ROUTES = [
  { method: 'patch' as const, path: '/v1/admin/feedback/123' },
  { method: 'delete' as const, path: '/v1/admin/feedback/123' },
  { method: 'post' as const, path: '/v1/admin/feedback/123/reply' },
];
const MGMT_ALL_ROUTES = [...MGMT_ANY_ADMIN_ROUTES, ...MGMT_SUPER_ADMIN_ONLY_ROUTES];

beforeEach(() => {
  jest.clearAllMocks();
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

// D1b (roleAuth配線監査) で feedback は既存パターンで安全と確認済み・未変更。
// 回帰防止のため tenant_id 欠落時の挙動を明示的に固定する。
describe('feedback management routes — 回帰pin: client_admin missing tenant_id', () => {
  MGMT_ANY_ADMIN_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — client_admin with empty tenant_id は 200 を返さない`, async () => {
      const app = makeAppMgmt({ role: 'client_admin', tenant_id: '' });
      const res = await (request(app) as any)[method](path);
      expect(res.status).not.toBe(200);
    });
  });
});
