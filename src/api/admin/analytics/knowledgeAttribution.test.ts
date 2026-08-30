// src/api/admin/analytics/knowledgeAttribution.test.ts
// Phase68: ナレッジ別 CV 影響度集計 API のユニットテスト

import express from 'express';
import { request } from "../../../../tests/helpers/testServer";

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

// [H-5] GID 1217969425230400: このルートは成果分析(conversion, Growth〜)のplanゲートを
// 通るようになった。ゲート自体の回帰はanalyticsPlanGate.test.tsで確認済みのため、ここでは
// 集計ロジック(mockQueryの呼び出し順・SQL内容)の検証に集中できるようqueryTenantPlanOrThrowを
// growth固定でモックする。
// [H-7] GID 1217969364194602: checkAnalyticsPlanAccess は DB障害を403で覆い隠さないよう
// queryTenantPlan から queryTenantPlanOrThrow に切り替わった。ここでモックする対象も
// 追従させる(旧名のままだと実装のqueryTenantPlanOrThrowが素通りし、モックされた
// 空のpool({})に対して本物のクエリを投げて例外になる)。
jest.mock('../../../lib/billing/planFeatures', () => ({
  ...jest.requireActual('../../../lib/billing/planFeatures'),
  queryTenantPlanOrThrow: jest.fn().mockResolvedValue('growth'),
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
  injected_count: number;
  conversation_count: number;
  conversion_count: number;
  conversion_rate: number;
  avg_judge_score: number | null;
  raw_text: string | null;
  book_title: string | null;
  prev_rate: number;
  prev_conversation_count?: number;
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
        injected_count: 0,
        conversation_count: 38,
        conversion_count: 12,
        conversion_rate: 12 / 38,
        avg_judge_score: 72.5,
        raw_text: '返品はできますか？',
        book_title: null,
        prev_rate: 0.25, // 上昇傾向
      },
      {
        chunk_id: '202',
        src_type: 'book',
        principle: 'reciprocity',
        usage_count: 15,
        injected_count: 9, // 心理学原則として注入された回数(usage_countの内数)
        conversation_count: 14,
        conversion_count: 7,
        conversion_rate: 0.5,
        avg_judge_score: 80.0,
        raw_text: '返報性の原理は顧客心理に強く働く',
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
    // T3: 注入軸(usage_countとは別枠。injected_countはusage_countの内数)
    expect(bookItem.injected_count).toBe(9);
    expect(faqItem.injected_count).toBe(0);

    // summary
    expect(res.body.summary.total_chunks_used).toBe(2);
    expect(res.body.summary.top_performer.chunk_id).toBe('202');
    expect(res.body.summary.worst_performer.chunk_id).toBe('101');
  });

  it('前期間の実績が0件のチャンクは up/down/stable を出さず insufficient_data を返す(CLAUDE.md禁止34)', async () => {
    const rows: AttrRow[] = [
      {
        chunk_id: '303',
        src_type: 'faq',
        principle: null,
        usage_count: 5,
        injected_count: 0,
        conversation_count: 5,
        conversion_count: 3,
        conversion_rate: 0.6,
        avg_judge_score: null,
        raw_text: '新規追加されたFAQ',
        book_title: null,
        prev_rate: 0, // 前期間データなしの便宜上の0（架空の下降と混同しないこと）
        prev_conversation_count: 0,
      },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.items[0].trend).toBe('insufficient_data');
  });

  it('SQL の ORDER BY が sort_by に合わせて切り替わる (usage_count)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ sort_by: 'usage_count' })
      .set('x-tenant-id', 'tenant-A');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sqlArg = String(mockQuery.mock.calls[0]?.[0] ?? '');
    expect(sqlArg).toMatch(/ORDER BY\s+usage_count\s+DESC/);
    // ORDER BY 節に c. プレフィックスが付いていないこと（CTE スコープ外）
    expect(sqlArg).not.toMatch(/ORDER BY\s+c\.usage_count/);
  });

  it('SQL の ORDER BY が sort_by に合わせて切り替わる (judge_score)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ sort_by: 'judge_score' })
      .set('x-tenant-id', 'tenant-A');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sqlArg = String(mockQuery.mock.calls[0]?.[0] ?? '');
    expect(sqlArg).toMatch(/ORDER BY\s+avg_judge_score\s+DESC/);
    expect(sqlArg).not.toMatch(/ORDER BY\s+c\.avg_judge_score/);
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

  // 2026-08-29 レビュー是正: usage_count が rag_sources の全行(注入専用行を含む)を
  // 数えていたため、「検索でヒットした回数」という既存の意味が壊れ、過去データと
  // 比較不能になっていた(タスクの明示制約違反)。retrieved フラグで集計対象を
  // 絞ったことを SQL テキストで固定する。
  it('usage_count は retrieved のみを数え、注入専用行(retrieved: false)を増やさない', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .set('x-tenant-id', 'tenant-A');

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // 生産側(searchAgent.ts)と同じキー名で retrieved を取り出していること
    expect(sql).toContain(`(src->>'retrieved')::boolean AS retrieved`);
    // usage_count は COUNT(*) 全件ではなく retrieved で絞った FILTER になっていること
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE COALESCE\(retrieved, true\)\)::int AS usage_count/);
    expect(sql).not.toMatch(/COUNT\(\*\)::int AS usage_count/);
  });

  it('usage_count は DB(SQLのCOALESCE(retrieved,true))が返した値をそのまま使い、JS側でinjected_countと合算しない', async () => {
    // このテストは SQL の COALESCE(retrieved, true) 自体(NULL=旧形式行を true 扱いに
    // する後方互換)を実行はしない(本ファイルは pool.query をモックしており実DBが無い)。
    // 代わりに、DB がその結果として返す usage_count(旧形式行を含めた値)を
    // ルート層が書き換えずにそのまま返すことを確認する — usage_count に
    // injected_count を足し込むような回帰が起きれば、この値がズレて検出できる。
    const rows: AttrRow[] = [
      {
        chunk_id: '404',
        src_type: 'book',
        principle: 'reciprocity',
        usage_count: 3, // DBがCOALESCE(retrieved,true)で絞った後の値(旧形式行込み)
        injected_count: 7, // usage_countより大きい(注入のみの行が多いケース)
        conversation_count: 3,
        conversion_count: 1,
        conversion_rate: 1 / 3,
        avg_judge_score: 70,
        raw_text: '返報性の原理は顧客心理に強く働く',
        book_title: '影響力の武器',
        prev_rate: 0,
        prev_conversation_count: 0,
      },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .set('x-tenant-id', 'tenant-A');

    expect(res.body.items[0].usage_count).toBe(3);
    expect(res.body.items[0].injected_count).toBe(7);
  });

  // 2026-08-29 テスト強化: retrieved/injected の4通りの組み合わせが1チャンクに
  // 混在したときの usage_count / injected_count。実SQLの FILTER 集計は本ファイルの
  // mockQuery では実行できない(pool.query をモックしているため)。summaryQueries.ts の
  // コメントに明記された仕様(COALESCE(retrieved, true) で usage_count、injected で
  // injected_count)をここでも独立に再現し、DB応答としてルートへ渡すことで、
  // どちらか一方の集計ロジックだけを見て「合っていそう」と誤読しないよう固定する。
  it('retrieved/injectedの4通りが1チャンクに混在したときの usage_count / injected_count', async () => {
    const rawEntries: Array<{ retrieved?: boolean; injected?: boolean }> = [
      { retrieved: true, injected: true }, // 検索ヒット かつ 注入
      { retrieved: true }, // 検索ヒットのみ
      { retrieved: false, injected: true }, // 注入専用（通常RAGに乗らない）→ usage_count に入らない
      {}, // 旧形式（キー無し）→ COALESCE(retrieved, true) で usage_count に入る
    ];
    const expectedUsageCount = rawEntries.filter((e) => (e.retrieved ?? true) === true).length;
    const expectedInjectedCount = rawEntries.filter((e) => e.injected === true).length;
    expect(expectedUsageCount).toBe(3);
    expect(expectedInjectedCount).toBe(2);

    const rows: AttrRow[] = [
      {
        chunk_id: '505',
        src_type: 'book',
        principle: 'reciprocity',
        usage_count: expectedUsageCount,
        injected_count: expectedInjectedCount,
        conversation_count: 4,
        conversion_count: 1,
        conversion_rate: 0.25,
        avg_judge_score: 60,
        raw_text: '混在パターン',
        book_title: '影響力の武器',
        prev_rate: 0,
        prev_conversation_count: 0,
      },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .set('x-tenant-id', 'tenant-A');

    expect(res.body.items[0].usage_count).toBe(3);
    expect(res.body.items[0].injected_count).toBe(2);
  });

  // judge_score が全件 null のとき、ORDER BY に NULLS LAST が効いていないと
  // 昇順/降順の実装次第で null が上位を占めうる(CLAUDE.md 禁止34と同系統の懸念)。
  it('sort_by=judge_score のとき ORDER BY に NULLS LAST が付く(全件nullで上位を占めない)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ sort_by: 'judge_score' })
      .set('x-tenant-id', 'tenant-A');

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY\s+avg_judge_score\s+DESC\s+NULLS LAST/);
  });

  // -------------------------------------------------------------------------
  // RBAC
  // -------------------------------------------------------------------------

  it('super_admin: テナントを連続で切り替えても、各リクエストのパラメータは常にそのリクエスト自身のテナントに束縛される(前テナントの値が残らない)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ tenant_id: 'tenant-X' })
      .set('x-role', 'super_admin');

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/v1/admin/analytics/knowledge-attribution')
      .query({ tenant_id: 'tenant-Y' })
      .set('x-role', 'super_admin');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [, paramsFirst] = mockQuery.mock.calls[0] as [string, unknown[]];
    const [, paramsSecond] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(paramsFirst[0]).toBe('tenant-X');
    expect(paramsSecond[0]).toBe('tenant-Y');
    expect(paramsSecond).not.toContain('tenant-X');
  });

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
