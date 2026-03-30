// tests/phase48/avatarConfigConsistency.test.ts
// Bug-3: Super Admin / Client Admin 間のアバター設定表示不整合テスト
//
// client_admin は自テナントのみ取得できる
// client_admin は他テナントの設定が見えない
// super_admin は全テナント取得できる

import express from 'express';
import request from 'supertest';
import { registerAvatarConfigRoutes } from '../../src/api/admin/avatar/routes';

// ---------------------------------------------------------------------------
// Mock Supabase auth middleware
// ---------------------------------------------------------------------------

function mockSupabaseAuth(
  tenantId: string,
  role: 'super_admin' | 'client_admin'
) {
  return (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  };
}

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

const TENANT_A_ROWS = [
  { id: 'cfg-1', tenant_id: 'tenant-a', name: 'Avatar A1' },
  { id: 'cfg-2', tenant_id: 'tenant-a', name: 'Avatar A2' },
];

const TENANT_B_ROWS = [
  { id: 'cfg-3', tenant_id: 'tenant-b', name: 'Avatar B1' },
];

const ALL_ROWS = [...TENANT_A_ROWS, ...TENANT_B_ROWS];

function makeMockDb() {
  return {
    query: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (params && params.length > 0) {
        const tenantFilter = params[0] as string;
        const filtered = ALL_ROWS.filter((r) => r.tenant_id === tenantFilter);
        return { rows: filtered, rowCount: filtered.length };
      }
      // No filter → return all (super_admin case)
      return { rows: ALL_ROWS, rowCount: ALL_ROWS.length };
    }),
    connect: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers: mock supabaseAuthMiddleware
// ---------------------------------------------------------------------------

jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => next(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/avatar/configs — tenant isolation', () => {
  it('client_admin with valid tenantId only sees own tenant configs', async () => {
    const db = makeMockDb();
    const app = express();
    app.use(express.json());
    app.use(mockSupabaseAuth('tenant-a', 'client_admin'));
    registerAvatarConfigRoutes(app, db);

    const res = await request(app).get('/v1/admin/avatar/configs');

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);
    expect(res.body.configs.every((c: any) => c.tenant_id === 'tenant-a')).toBe(true);
  });

  it('client_admin cannot see other tenant configs', async () => {
    const db = makeMockDb();
    const app = express();
    app.use(express.json());
    app.use(mockSupabaseAuth('tenant-a', 'client_admin'));
    registerAvatarConfigRoutes(app, db);

    const res = await request(app).get('/v1/admin/avatar/configs');

    expect(res.status).toBe(200);
    const configs = res.body.configs as Array<{ tenant_id: string }>;
    const exposedTenantB = configs.some((c) => c.tenant_id === 'tenant-b');
    expect(exposedTenantB).toBe(false);
  });

  it('client_admin with empty tenantId returns 403 (prevents full exposure)', async () => {
    const db = makeMockDb();
    const app = express();
    app.use(express.json());
    // Empty tenantId — simulates Bug-3 condition
    app.use(mockSupabaseAuth('', 'client_admin'));
    registerAvatarConfigRoutes(app, db);

    const res = await request(app).get('/v1/admin/avatar/configs');

    expect(res.status).toBe(403);
  });

  it('super_admin without query param gets all configs', async () => {
    const db = makeMockDb();
    const app = express();
    app.use(express.json());
    app.use(mockSupabaseAuth('', 'super_admin'));
    registerAvatarConfigRoutes(app, db);

    const res = await request(app).get('/v1/admin/avatar/configs');

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(3);
  });

  it('super_admin with tenant query param gets filtered configs', async () => {
    const db = makeMockDb();
    const app = express();
    app.use(express.json());
    app.use(mockSupabaseAuth('', 'super_admin'));
    registerAvatarConfigRoutes(app, db);

    const res = await request(app).get('/v1/admin/avatar/configs?tenant=tenant-b');

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(1);
    expect(res.body.configs[0].tenant_id).toBe('tenant-b');
  });
});
