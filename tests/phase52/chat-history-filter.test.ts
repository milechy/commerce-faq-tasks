// tests/phase52/chat-history-filter.test.ts
// Phase52b: chat-history sessions API sort/filter params

jest.mock('../../src/lib/db', () => ({ getPool: jest.fn() }));
jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import { getPool } from '../../src/lib/db';
import { registerChatHistoryRoutes } from '../../src/api/admin/chat-history/routes';

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
});
