// tests/phase52/chat-history-filter.test.ts
// Phase52b: chat-history sessions API sort/filter params

jest.mock('../../src/lib/db', () => ({ getPool: jest.fn() }));
jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import { request } from "../helpers/testServer";
import { getPool } from '../../src/lib/db';
import { registerChatHistoryRoutes } from '../../src/api/admin/chat-history/routes';
import { normalizeSessionListParams } from '../../src/api/admin/chat-history/chatHistoryRepository';

function makeApp(role = 'super_admin', tenantId = 'tenant-super') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
    next();
  });
  registerChatHistoryRoutes(app);
  return app;
}

function makeMockPool(rows: any[] = [], total = 0) {
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [{ count: String(total) }] })
    .mockResolvedValueOnce({ rows });
  return { query } as any;
}

const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;

beforeEach(() => jest.clearAllMocks());

describe('GET /v1/admin/chat-history/sessions — Phase52b filters', () => {
  it('1. default limit is 20', async () => {
    mockGetPool.mockReturnValue(makeMockPool([], 0));
    const app = makeApp();
    const res = await request(app).get('/v1/admin/chat-history/sessions');
    expect(res.status).toBe(200);
    const pool = (getPool as jest.MockedFunction<typeof getPool>).mock.results[0]?.value as any;
    const listCall = pool.query.mock.calls[1];
    expect(listCall[1]).toContain(20);
  });

  it('2. period=30 appends started_at range condition', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/chat-history/sessions?period=30');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain("INTERVAL '30 days'");
  });

  it('3. search appends EXISTS subquery on chat_messages', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/chat-history/sessions?search=予算');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain('chat_messages');
    expect(countCall[0]).toContain('ILIKE');
    expect(countCall[1]).toContain('%予算%');
  });

  it('4. sentiment=positive appends conversation_evaluations EXISTS (score >= 70)', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/chat-history/sessions?sentiment=positive');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain('conversation_evaluations');
    expect(countCall[0]).toContain('score >= 70');
  });

  it('5. sentiment=negative appends score < 60 condition', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/chat-history/sessions?sentiment=negative');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain('score < 60');
  });

  it('6. sort_by=message_count changes ORDER BY', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/chat-history/sessions?sort_by=message_count&sort_order=asc');
    const listCall = pool.query.mock.calls[1];
    expect(listCall[0]).toContain('s.message_count ASC');
  });

  it('7. sort_by=score uses conversation_evaluations subquery in ORDER BY', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/chat-history/sessions?sort_by=score');
    const listCall = pool.query.mock.calls[1];
    expect(listCall[0]).toContain('conversation_evaluations');
    expect(listCall[0]).toContain('NULLS LAST');
  });

  it('8. client_admin cannot filter other tenants (tenant from JWT)', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp('client_admin', 'tenant-abc');
    // Even if query param ?tenant=other-tenant is passed, JWT tenant is enforced
    await request(app).get('/v1/admin/chat-history/sessions?tenant=other-tenant');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[1]).toContain('tenant-abc');
    expect(countCall[1]).not.toContain('other-tenant');
  });

  // ---------------------------------------------------------------------------
  // allowlist 回帰: period / sort_order は SQL に文字列補間されるため、allowlist 外の
  // 値が絶対に SQL テキストへ到達しないことを固定する。routes.ts 経由(HTTPクエリ文字列)
  // と normalizeSessionListParams() 直呼び出し(agent の LLM 由来引数を模す)の両方で確認する。
  // ---------------------------------------------------------------------------
  it('9. allowlist外の period(SQL断片を模した値)はINTERVAL句に補間されない', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app)
      .get('/v1/admin/chat-history/sessions')
      .query({ period: "7 days'; DROP TABLE chat_sessions; --" });
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).not.toContain('DROP TABLE');
    expect(countCall[0]).not.toContain('INTERVAL');
  });

  it('10. allowlist外のsort_order(SQL断片を模した値)はORDER BY句に補間されない', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app)
      .get('/v1/admin/chat-history/sessions')
      .query({ sort_order: 'desc; DROP TABLE chat_sessions; --' });
    const listCall = pool.query.mock.calls[1];
    expect(listCall[0]).not.toContain('DROP TABLE');
    // allowlist外はデフォルト('desc'相当のDESC)にフォールバックする
    expect(listCall[0]).toContain('s.last_message_at DESC');
  });

  it('11. normalizeSessionListParams: allowlist外のperiod/sort_by/sort_order/sentimentはundefinedに落ちる', () => {
    const n = normalizeSessionListParams({
      period: "7 days'; --",
      sort_by: 'message_count; DROP TABLE',
      sort_order: 'desc; --',
      sentiment: 'angry',
    });
    expect(n.period).toBeUndefined();
    expect(n.sort_by).toBeUndefined();
    expect(n.sort_order).toBeUndefined();
    expect(n.sentiment).toBeUndefined();
  });

  it('12. normalizeSessionListParams: allowlist内の値はそのまま通す(冪等)', () => {
    const once = normalizeSessionListParams({ period: '30', sort_by: 'score', sort_order: 'asc', sentiment: 'positive' });
    const twice = normalizeSessionListParams(once);
    expect(twice).toEqual(once);
    expect(once.period).toBe('30');
    expect(once.sort_by).toBe('score');
    expect(once.sort_order).toBe('asc');
    expect(once.sentiment).toBe('positive');
  });

  it.each([
    [0, 1], [1, 1], [200, 200], [201, 200], [-1, 1], [NaN, 20], ['abc', 20], [undefined, 20],
  ])('13. limit=%p は %p にクランプされる', (input, expected) => {
    expect(normalizeSessionListParams({ limit: input }).limit).toBe(expected);
  });

  it.each([
    [0, 0], [-1, 0], [NaN, 0], ['abc', 0], [undefined, 0], [500, 500],
  ])('14. offset=%p は %p にクランプされる', (input, expected) => {
    expect(normalizeSessionListParams({ offset: input }).offset).toBe(expected);
  });

  it('15. search の % _ \\ はワイルドカードとして解釈されない(エスケープされる)', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app)
      .get('/v1/admin/chat-history/sessions')
      .query({ search: '50%_off\\deal' });
    const countCall = pool.query.mock.calls[0];
    // \\ % _ の直前にエスケープの \\ が入り、意図しない広域一致にならない
    expect(countCall[1]).toContain('%50\\%\\_off\\\\deal%');
  });

  it('16. HTTP経由のlimit/offset境界値(0/負値/NaN/上限超過)がクランプされてSQLに渡る', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app)
      .get('/v1/admin/chat-history/sessions')
      .query({ limit: '-1', offset: '-5' });
    const listCall = pool.query.mock.calls[1];
    // super_adminがtenant/search未指定なのでargsは[limit, offset]のみ
    expect(listCall[1]).toEqual([1, 0]);
  });

  it('17. 応答bodyのlimit/offsetはgetSessionsの実効値(クランプ後)を反映する', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    const res = await request(app)
      .get('/v1/admin/chat-history/sessions')
      .query({ limit: '9999', offset: '-3' });
    expect(res.body.limit).toBe(200);
    expect(res.body.offset).toBe(0);
  });
});
