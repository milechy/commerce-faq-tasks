// src/api/conversion/abTestRoutes.test.ts
// GET /v1/admin/ab/experiments が一覧の時点で total_exposed(ab_resultsとの突合済み件数)を
// 返すことの回帰テスト。conversion ダッシュボード(admin-ui)が「実施中0件」と
// 「実施中だがサンプル不足」を区別して、母数不足でも判定に使える情報(現在N/必要N)を
// 出せるようにするための配線(CLAUDE.md 禁止34: 母数を隠さない)。

import express from 'express';
import { request } from "../../../tests/helpers/testServer";
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

  registerAbTestRoutes(app, mockDb);
  return { app, mockDb };
}

describe('GET /v1/admin/ab/experiments — total_exposed', () => {
  it('super_adminのとき、一覧クエリが ab_results と突合した total_exposed を含めて返す', async () => {
    const { app, mockDb } = makeApp('super_admin', 'tenant-a', [
      {
        rows: [
          {
            id: 1,
            tenant_id: 'tenant-a',
            name: '挨拶パターンA/B',
            variant_a: { text: 'こんにちは' },
            variant_b: { text: 'いらっしゃいませ' },
            traffic_split: 0.5,
            status: 'running',
            min_sample_size: 100,
            created_at: '2026-08-01T00:00:00Z',
            total_exposed: 12,
          },
        ],
      },
    ]);

    const res = await request(app).get('/v1/admin/ab/experiments');

    expect(res.status).toBe(200);
    expect(res.body.experiments[0].total_exposed).toBe(12);
    // ab_results 未突合(=まだ露出が無い)実験が混ざっても 0 で埋まる(NULLではない)ことを
    // クエリ側の COALESCE で保証する。ここでは発行SQLにその文言があることだけ確認する。
    const sql = mockDb.query.mock.calls[0]?.[0] ?? '';
    expect(sql).toMatch(/COALESCE\(r\.total_exposed, 0\)/);
    expect(sql).toMatch(/LEFT JOIN/);
    expect(sql).toMatch(/FROM ab_results/);
  });

  it('client_adminのとき、tenant_id で自テナントに絞り込む(他テナントの実験を返さない)', async () => {
    const { app, mockDb } = makeApp('client_admin', 'tenant-a', [
      { rows: [{ plan: 'growth' }] }, // checkAbTestPlanAccess の plan 確認
      { rows: [] },
    ]);

    const res = await request(app).get('/v1/admin/ab/experiments');

    expect(res.status).toBe(200);
    expect(res.body.experiments).toEqual([]);
    const secondCall = mockDb.query.mock.calls[1];
    expect(secondCall?.[0]).toMatch(/WHERE e\.tenant_id = \$1/);
    expect(secondCall?.[1]).toEqual(['tenant-a']);
  });
});
