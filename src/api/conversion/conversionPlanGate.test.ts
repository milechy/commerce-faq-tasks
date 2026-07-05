// src/api/conversion/conversionPlanGate.test.ts
// GID: LP料金表(Growth〜: CV計測)に基づくplan制限の回帰テスト。
// db可用性チェックの後段でplanを確認し、client_adminのみ対象とすることを検証する。

import express from 'express';
import request from 'supertest';
import { registerConversionRoutes } from './conversionRoutes';
import { registerAbTestRoutes } from './abTestRoutes';

jest.mock('../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: { role: req._mockRole ?? 'client_admin', tenant_id: req._mockTenantId ?? 'tenant-a' },
    };
    next();
  },
}));

type Role = 'super_admin' | 'client_admin';

function makeApp(
  role: Role,
  tenantId: string,
  queryResponses: Array<{ rows: any[]; rowCount?: number } | Error>,
) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockRole = role;
    req._mockTenantId = tenantId;
    req.tenantId = tenantId;
    next();
  });

  let callCount = 0;
  const mockDb: any = {
    query: jest.fn().mockImplementation(() => {
      const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    }),
  };

  const apiStack = [(req: any, _: any, next: any) => next()];
  registerConversionRoutes(app, apiStack, mockDb);
  registerAbTestRoutes(app, mockDb);
  return { app, mockDb };
}

describe('GET /v1/admin/conversion/attributions — plan ゲート', () => {
  it('client_admin + plan=starter → 403 plan_upgrade_required、以降のクエリは実行されない', async () => {
    const { app, mockDb } = makeApp('client_admin', 'tenant-a', [{ rows: [{ plan: 'starter' }] }]);
    const res = await request(app).get('/v1/admin/conversion/attributions');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('plan_upgrade_required');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)', async () => {
    const { app, mockDb } = makeApp('super_admin', 'tenant-a', [
      { rows: [] }, { rows: [] }, { rows: [{ total: '0', avg_temp_score: null }] }, { rows: [] },
    ]);
    const res = await request(app).get('/v1/admin/conversion/attributions');

    expect(res.status).toBe(200);
    const firstCallSql = mockDb.query.mock.calls[0]?.[0] ?? '';
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});

describe('GET /v1/admin/conversion/effectiveness — plan ゲート', () => {
  it('client_admin + plan=starter → 403 plan_upgrade_required', async () => {
    const { app, mockDb } = makeApp('client_admin', 'tenant-a', [{ rows: [{ plan: 'starter' }] }]);
    const res = await request(app).get('/v1/admin/conversion/effectiveness');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('plan_upgrade_required');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });
});

describe('GET /v1/admin/ab/experiments — plan ゲート', () => {
  it('client_admin + plan=starter → 403 plan_upgrade_required', async () => {
    const { app, mockDb } = makeApp('client_admin', 'tenant-a', [{ rows: [{ plan: 'starter' }] }]);
    const res = await request(app).get('/v1/admin/ab/experiments');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('plan_upgrade_required');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('client_admin + plan=growth → ゲートを通過する(403にならない)', async () => {
    const { app } = makeApp('client_admin', 'tenant-a', [{ rows: [{ plan: 'growth' }] }, { rows: [] }]);
    const res = await request(app).get('/v1/admin/ab/experiments');

    expect(res.status).not.toBe(403);
  });

  it('super_adminはplanゲートをバイパスする', async () => {
    const { app, mockDb } = makeApp('super_admin', 'tenant-a', [{ rows: [] }]);
    const res = await request(app).get('/v1/admin/ab/experiments');

    expect(res.status).not.toBe(403);
    const firstCallSql = mockDb.query.mock.calls[0]?.[0] ?? '';
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});
