// src/api/admin/analytics/knowledgeAttribution.test.ts
// Phase68: ナレッジ別 CV 影響度集計 API のユニットテスト

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// DB モック
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn().mockResolvedValue(false),
}));

// supabase auth middleware: x-role, x-tenant-id ヘッダでロール/テナントを注入
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: {
        role: (req.headers['x-role'] as string) ?? 'client_admin',
        tenant_id: (req.headers['x-tenant-id'] as string) ?? 'tenant-A',
      },
    };
    next();
  },
}));

import { registerAnalyticsRoutes } from './routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAnalyticsRoutes(app);
  return app;
}

// テスト用の集計結果レコード (実 SQL CTE の joined 相当)
type AttrRow = {
  chunk_id: string;
  src_type: 'faq' | 'book' | null;
  principle: string | null;
  usage_count: number;
  conversation_count: number;
  conversion_count: number;
  conversion_rate: number;
  avg_judge_score: number | null;
  title: string | null;
  book_title: string | null;
  prev_rate: number;
};

describe('GET /v1/admin/analytics/knowledge-attribution', () => {
  beforeEach(() => mockQuery.mockClear());

  // -------------------------------------------------------------------------
  // 正常系
  // -------------------------------------------------------------------------

  it('FAQ/書籍混在の集計結果を整形して返す', async () => {
    const rows: AttrRow[] = [
      {
        chunk_id: '101',
        src_type: 'faq',
        principle: null,
        usage_count: 40,
        conversation_count: 38,
        conversion_count: 12,
        conversion_rate: 12 / 38,
        avg_judge_score: 72.5,
        title: '返品はできますか？',
        book_title: null,
        prev_rate: 0.25, // 上昇傾向
      },
      {
        chunk_id: '202',
        src_type: 'book',
        principle: 'reciprocity',
        usage_count: 15,
        conversation_count: 14,
        conversion_count: 7,
        conversion_rate: 0.5,
        avg_judge_score: 80.0,
        title: '返報性の原理は顧客心理に強く働く',
        book_title: '影響力の武器',
        prev_rate: 0.5, // stable
      },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ period: '30d', source_type: 'all', sort_by: 'conversion_rate' })
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe('tenant-A');
    expect(res.body.period).toBe('30d');
    expect(res.body.source_type).toBe('all');

    expect(res.body.items).toHaveLength(2);
    const faqItem = res.body.items.find((x: any) => x.chunk_id === '101');
    expect(faqItem.source).toBe('faq');
    expect(faqItem.title).toBe('返品はできますか？');
    expect(faqItem.conversion_rate).toBeCloseTo(12 / 38, 4);
    expect(faqItem.trend).toBe('up'); // 12/38 ≈ 0.316 > 0.25+0.02

    const bookItem = res.body.items.find((x: any) => x.chunk_id === '202');
    expect(bookItem.source).toBe('book');
    expect(bookItem.principle).toBe('reciprocity');
    expect(bookItem.title).toContain('影響力の武器');
    expect(bookItem.trend).toBe('stable'); // |0.5 - 0.5| < 0.02

    // summary
    expect(res.body.summary.total_chunks_used).toBe(2);
    expect(res.body.summary.top_performer.chunk_id).toBe('202');
    expect(res.body.summary.worst_performer.chunk_id).toBe('101');
  });

  it('SQL の ORDER BY が sort_by に合わせて切り替わる (usage_count)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ sort_by: 'usage_count' })
      .set('x-tenant-id', 'tenant-A');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sqlArg = String(mockQuery.mock.calls[0]?.[0] ?? '');
    expect(sqlArg).toMatch(/ORDER BY\s+c\.usage_count\s+DESC/);
  });

  it('source_type=book のとき LATERAL に絞り込みパラメータが追加される', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ source_type: 'book' })
      .set('x-tenant-id', 'tenant-A');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("(src->>'source') = $3");
    expect(params).toEqual(['tenant-A', '30 days', 'book']);
  });

  // -------------------------------------------------------------------------
  // RBAC
  // -------------------------------------------------------------------------

  it('super_admin: ?tenant_id で任意テナントを指定可能', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ tenant_id: 'tenant-X' })
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('tenant-X');
  });

  it('super_admin が tenant_id を指定しない場合は 400', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .set('x-role', 'super_admin')
      .set('x-tenant-id', ''); // empty

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('client_admin は JWT の tenant_id が必ず使われ、?tenant_id クエリは無視される', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ tenant_id: 'other-tenant' })
      .set('x-tenant-id', 'tenant-A'); // client_admin

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('tenant-A');
  });

  // -------------------------------------------------------------------------
  // バリデーション
  // -------------------------------------------------------------------------

  it('不正な sort_by は conversion_rate にフォールバック', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ sort_by: 'drop_all_tables' })
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.sort_by).toBe('conversion_rate');
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/drop_all_tables/);
  });

  it('period=7d の interval が渡される', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ period: '7d' })
      .set('x-tenant-id', 'tenant-A');

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe('7 days');
  });

  it('DB エラー時は 500', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(500);
  });

  it('空の集計結果でもサマリーは 0 で返る', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.summary.total_chunks_used).toBe(0);
    expect(res.body.summary.avg_conversion_rate).toBe(0);
    expect(res.body.summary.top_performer).toBeNull();
    expect(res.body.summary.worst_performer).toBeNull();
  });
});
