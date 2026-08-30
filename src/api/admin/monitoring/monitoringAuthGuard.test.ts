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
  getPool: jest.fn(() => null),
  pool: null,
}));

import express from 'express';
import { request } from "../../../../tests/helpers/testServer";
import { logger } from '../../../lib/logger';
import { getPool } from '../../../lib/db';
import { registerMonitoringRoutes, computeKpis } from './routes';

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

describe('monitoring — client_admin missing tenant_id (fail-closed)', () => {
  it('client_admin with empty tenant_id → 403 AUTHZ_TENANT_MISSING (not unscoped KPI aggregate)', async () => {
    const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: '' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_TENANT_MISSING');
    expect(logger.warn).toHaveBeenCalled();
  });
  it('client_admin without app_metadata.tenant_id at all → 403 AUTHZ_TENANT_MISSING', async () => {
    const app = makeApp({ app_metadata: { role: 'client_admin' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_TENANT_MISSING');
  });
});

describe('monitoring — super_admin without tenant_id is NOT denied (only client_admin is)', () => {
  it('super_admin with no tenant_id → 200, not 403 (getPool mocked to null → fallback zeros)', async () => {
    const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 't@t.com' });
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.completionRate).toBe(0);
  });
});

describe('computeKpis — pure aggregation logic (壊れやすいポイント: SQLパラメータ番号付け)', () => {
  function mockDb(responses: { total: number; completed: number; fallback: number }) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: String(responses.total) }] };
      if (sql.includes('COUNT(*) AS completed')) return { rows: [{ completed: String(responses.completed) }] };
      if (sql.includes('fallback_count')) return { rows: [{ fallback_count: String(responses.fallback) }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    return { query };
  }

  it('正常系: 部分完了・部分フォールバックで正しい比率を計算する', async () => {
    const db = mockDb({ total: 200, completed: 150, fallback: 20 });
    const result = await computeKpis(db, null);
    expect(result.totalSessions).toBe(200);
    expect(result.completionRate).toBe(75); // 150/200 * 100
    expect(result.fallbackRate).toBe(10); // 20/200 * 100
  });

  it('境界値: total=0 のときゼロ除算せず completionRate=100/fallbackRate=0 を返す', async () => {
    const db = mockDb({ total: 0, completed: 0, fallback: 0 });
    const result = await computeKpis(db, 't1');
    expect(result).toEqual({ completionRate: 100, fallbackRate: 0, totalSessions: 0 });
    // total=0 で早期returnするため、completed/fallbackクエリは発行されないはず
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('境界値: 全件完了・全件フォールバックで100%になる（丸め誤差で99.9/100.1にならない）', async () => {
    const db = mockDb({ total: 3, completed: 3, fallback: 3 });
    const result = await computeKpis(db, null);
    expect(result.completionRate).toBe(100);
    expect(result.fallbackRate).toBe(100);
  });

  it('tenantFilter=null: SQLパラメータ数とプレースホルダ番号がズレない（fallbackクエリが$2以降を正しく使う）', async () => {
    const db = mockDb({ total: 5, completed: 3, fallback: 1 });
    await computeKpis(db, null);
    const fallbackCall = (db.query as jest.Mock).mock.calls.find((c) => String(c[0]).includes('fallback_count'));
    expect(fallbackCall).toBeDefined();
    const [sql, params] = fallbackCall!;
    expect(sql).not.toContain('tenant_id'); // tenantFilter無しならtenant_id条件を含まない
    expect(params).toHaveLength(5); // [window, 4 fallbackPhrases] — tenantIdが混入していない
    expect(sql.match(/\$\d+/g)).toEqual(['$1', '$2', '$3', '$4', '$5']);
  });

  it('tenantFilter指定時: fallbackクエリのtenant_id条件が$2を参照し、フレーズは$3以降にズレる', async () => {
    const db = mockDb({ total: 5, completed: 3, fallback: 1 });
    await computeKpis(db, 'tenant-a');
    const fallbackCall = (db.query as jest.Mock).mock.calls.find((c) => String(c[0]).includes('fallback_count'));
    const [sql, params] = fallbackCall!;
    expect(sql).toContain('AND cm.tenant_id = $2');
    expect(params).toEqual(['30 days', 'tenant-a', '%記載がありません%', '%お答えできません%', '%情報がありません%', '%見つかりませんでした%']);
    // フレーズ条件(cm.content ILIKE ...)は tenant_id が$2を占有した分、$3〜$6にズレる。
    // 万一ズレると params の要素数とプレースホルダ数が不一致になり、pg が実行時エラーを返す。
    const phraseConditionPlaceholders = [...sql.matchAll(/cm\.content ILIKE \$(\d+)/g)].map((m) => m[1]);
    expect(phraseConditionPlaceholders).toEqual(['3', '4', '5', '6']);
  });

  it('イレギュラー: DB行の値が想定外の型(null/undefined)でもクラッシュせずデフォルト0扱いする', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{}] })) }; // total列が無い行
    const result = await computeKpis(db, null);
    expect(result.totalSessions).toBe(0);
  });
});

describe('computeKpis — DB例外はそのまま伝播する(呼び出し元のtry/catchが500化する契約)', () => {
  it('DBクエリが例外を投げると computeKpis も reject する（握りつぶさない）', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('relation "chat_sessions" does not exist')) };
    await expect(computeKpis(db, null)).rejects.toThrow();
  });
});

// tuning/objection-patterns と異なり、monitoring KPIs には super_admin 向けの
// 「?tenant= で対象テナントを指定してプレビューする」経路が存在しない
// (routes.ts: `tenantFilter = isSuperAdmin ? null : jwtTenantId` — クエリを一切見ない)。
// この非対称性を明示的にテストで固定し、将来誰かがクエリパースを追加した際に
// 「対象テナント指定のはずが全テナント集計のまま」という無自覚な回帰を防ぐ。
describe('monitoring — previewMode: super_adminにテナント指定プレビュー経路が無いことの固定', () => {
  it('super_admin が ?tenant=other-tenant を付けても、DBには常に tenantFilter=null(全テナント集計)で問い合わせる', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const fakeDb = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: '10' }] };
        if (sql.includes('COUNT(*) AS completed')) return { rows: [{ completed: '5' }] };
        if (sql.includes('fallback_count')) return { rows: [{ fallback_count: '1' }] };
        return { rows: [] };
      }),
    };
    (getPool as jest.Mock).mockReturnValueOnce(fakeDb);

    const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 't@t.com' });
    const res = await request(app).get(`${PATH}?tenant=other-tenant`);

    expect(res.status).toBe(200);
    const fallbackCall = queries.find((q) => q.sql.includes('fallback_count'));
    expect(fallbackCall).toBeDefined();
    // tenantFilter=null なら fallback クエリに tenant_id 条件が入らない
    // (computeKpis の既存テストが固定している契約と同じ)。
    expect(fallbackCall!.sql).not.toContain('tenant_id');
  });
});
