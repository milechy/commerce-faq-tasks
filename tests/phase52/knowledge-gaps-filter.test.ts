// tests/phase52/knowledge-gaps-filter.test.ts
// Phase52b: knowledge-gaps API sort/filter/search params

jest.mock('../../src/lib/db', () => ({ getPool: jest.fn() }));
jest.mock('../../src/admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../src/api/admin/tenants/superAdminMiddleware', () => ({
  superAdminMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../src/agent/gap/gapRecommender', () => ({
  generateRecommendations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([]),
}));

import express from 'express';
import request from 'supertest';
import { getPool } from '../../src/lib/db';
import { registerKnowledgeGapPhase46Routes } from '../../src/api/admin/knowledge-gaps/routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  // Inject super_admin JWT
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: { tenant_id: 'tenant-super', role: 'super_admin' },
    };
    next();
  });
  registerKnowledgeGapPhase46Routes(app);
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

describe('GET /v1/admin/knowledge-gaps — Phase52b filters', () => {
  it('1. default limit is 20', async () => {
    mockGetPool.mockReturnValue(makeMockPool([], 0));
    const app = makeApp();
    const res = await request(app).get('/v1/admin/knowledge-gaps');
    expect(res.status).toBe(200);
    const pool = (getPool as jest.MockedFunction<typeof getPool>).mock.results[0]?.value as any;
    const listCall = pool.query.mock.calls[1];
    expect(listCall[1]).toContain(20); // limit=20 in args
  });

  it('2. trigger_type filter appends detection_source condition', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/knowledge-gaps?trigger_type=no_rag');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain('detection_source');
    expect(countCall[1]).toContain('no_rag');
  });

  it('3. search filter appends ILIKE condition', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/knowledge-gaps?search=返品');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain('user_question ILIKE');
    expect(countCall[1]).toContain('%返品%');
  });

  it('4. period=7 appends date range condition', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/knowledge-gaps?period=7');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain("INTERVAL '7 days'");
  });

  it('5. sort_by=created_at changes ORDER BY', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/knowledge-gaps?sort_by=created_at&sort_order=asc');
    const listCall = pool.query.mock.calls[1];
    expect(listCall[0]).toContain('created_at ASC');
  });

  it('6. response contains both items and gaps keys (backward compat)', async () => {
    mockGetPool.mockReturnValue(makeMockPool([{ id: 1, user_question: 'テスト', status: 'open', frequency: 3 }], 1));
    const app = makeApp();
    const res = await request(app).get('/v1/admin/knowledge-gaps');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('gaps');
    expect(res.body.items).toHaveLength(1);
  });

  it('7. invalid trigger_type is ignored (not added to query)', async () => {
    const pool = makeMockPool([], 0);
    mockGetPool.mockReturnValue(pool);
    const app = makeApp();
    await request(app).get('/v1/admin/knowledge-gaps?trigger_type=malicious_input');
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).not.toContain('detection_source');
  });
});
