// src/api/admin/knowledge-gaps/addKnowledgeIndexSync.test.ts
//
// ナレッジ配線是正 P6 (Asana GID 1217811058044468):
// POST /v1/admin/knowledge-gaps/:id/add-knowledge が embedding/ES 同期の
// 自前ヘルパ(正典 faqIndexSync.ts の複製)を持っており、しかも埋め込み対象が
// answer_text のみで、そのFAQが答えるべき質問文自体がベクトルに入っていなかった
// (質問文で検索してもヒットしない=検索精度の劣化)。
//
// 修正: 正典ヘルパ(faqCrudRoutes.ts 経由で faqIndexSync.ts を共有)に一本化し、
// 埋め込み対象を `${user_question}\n${answer_text}` にする。
// .claude/rules/knowledge.md 参照。

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('../tenants/superAdminMiddleware', () => ({
  superAdminMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../../agent/gap/gapRecommender', () => ({
  generateRecommendations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn().mockResolvedValue('test'),
}));
jest.mock('../../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  pool: { query: mockQuery },
  getPool: () => ({ query: mockQuery }),
}));

type Captured = { url: string; method: string; body?: string };
let captured: Captured[] = [];
const originalFetch = global.fetch;

function installFetchSpy() {
  global.fetch = jest.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    captured.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body });
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

import express from 'express';
import { request } from "../../../../tests/helpers/testServer";
import { registerKnowledgeGapPhase46Routes } from './routes';

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerKnowledgeGapPhase46Routes(app);
  return app;
}

const CLIENT_ADMIN = { app_metadata: { role: 'client_admin', tenant_id: 't1' } };

const CLAIMED_GAP_ROW = {
  tenant_id: 't1',
  user_question: 'この商品は返品できますか',
  detection_source: 'no_rag',
  frequency: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  captured = [];
  installFetchSpy();
  process.env['ES_URL'] = 'http://es.test:9200';
  mockQuery.mockImplementation((sql: string) => {
    // 2026-08-25是正(TOCTOU競合対策): approved→resolvedへの原子的なclaim UPDATE。
    // 是正前のSELECTに代わって成功経路の入口になる。
    if (/UPDATE knowledge_gaps\s+SET recommendation_status = 'resolved'/.test(sql)) {
      return Promise.resolve({ rows: [CLAIMED_GAP_ROW] });
    }
    if (/INSERT INTO faq_docs/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 999 }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env['ES_URL'];
});

describe('POST /v1/admin/knowledge-gaps/:id/add-knowledge — 索引同期の一本化', () => {
  it('embedding に質問文と回答の両方が入る(質問文のみが欠落しない)', async () => {
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app)
      .post('/v1/admin/knowledge-gaps/123/add-knowledge')
      .send({ answer_text: '30日以内であれば返品可能です' });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const embedInsert = mockQuery.mock.calls.find(([sql]: [string]) => /INSERT INTO faq_embeddings/.test(sql));
    expect(embedInsert).toBeDefined();
    const embeddedText = embedInsert![1][1] as string;
    expect(embeddedText).toContain('この商品は返品できますか');
    expect(embeddedText).toContain('30日以内であれば返品可能です');
  });

  it('ES upsert が faqEsDocId 規約(${faqId}_${tenantId})のURLへ送られる(自前実装ではなく正典ヘルパ経由)', async () => {
    const app = makeApp(CLIENT_ADMIN);

    await request(app)
      .post('/v1/admin/knowledge-gaps/123/add-knowledge')
      .send({ answer_text: '30日以内であれば返品可能です' });
    await new Promise((r) => setImmediate(r));

    const esWrites = captured.filter((c) => c.method === 'PUT');
    expect(esWrites.length).toBeGreaterThan(0);
    expect(esWrites[0]!.url).toContain('/_doc/999_t1');
  });
});
